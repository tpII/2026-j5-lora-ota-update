#include "node_application.h"

#include <Arduino.h>

#include "node_events.h"

namespace firmware {

// Console lines executed in one pass of the main loop. A command can take long, such as status with
// a line per neighbor or load_image with the Ed25519 verification of a whole image, and lines can
// queue up in the transports. Two per pass keep the console from delaying the reception and the
// transmission queue that the next pass serves; the rest wait for later passes.
static constexpr int MAXIMUM_COMMANDS_PER_POLL = 2;

static constexpr const char *ACCESS_POINT_FAILURE = "access point did not start";

// ---------------------------------------------------------------------------------------------
// Start and main loop

void NodeApplication::begin() {
  board_.begin();
  serial_.begin(CONSOLE_BAUD_RATE);
  console_.begin(serial_, wireless_, display_);
  events_.begin(console_);
  display_.begin();
  identity_.begin();

  const RadioStatus radioStatus = radio_.begin(board_, defaultRadioSettings());
  radioReady_ = radioStatus.succeeded;
  const bool wirelessReady = wireless_.begin(identity_.nodeId());
  // The first HELLO waits from the moment the node is ready to send it.
  const bool operatorKeyValid =
      services_.begin(events_, identity_.nodeId(), board_.model(), identity_, millis());

  writeBootEvent(events_, identity_.nodeId(), board_.model(), identity_.epoch());
  reportRadio();
  reportWireless();
  events_.debug("boot %04X %s e%u", identity_.nodeId(), board_.modelName(), identity_.epoch());
  if (!board_.isFrontEndVerified()) {
    events_.debug("front end not KCT8103L");
  }
  if (!operatorKeyValid) {
    events_.debug("operator key not valid");
  }
  if (!radioReady_) {
    events_.error("radio", ErrorReason::RadioFailure, "begin", radioStatus.code);
  }
  if (!wirelessReady) {
    events_.error("wifi", ErrorReason::WifiFailure, ACCESS_POINT_FAILURE);
  }
  updateStatusLine();
}

void NodeApplication::poll() {
  const uint32_t now = millis();
  serviceRadio(now);
  serviceTransmitter(now);
  serviceConsole(now);
  serviceWirelessChange();
  services_.poll(now);
  if (isDisplayRedrawAllowed(now)) {
    display_.poll(now);
  }
}

bool NodeApplication::isDisplayRedrawAllowed(uint32_t nowMillis) const {
  return !services_.isSuspended() && !radio_.isTransmitting() && services_.queue.isEmpty() &&
         !services_.echo.isPending() && !services_.transfer.isBurstInProgress(nowMillis);
}

// ---------------------------------------------------------------------------------------------
// Radio

void NodeApplication::serviceRadio(uint32_t nowMillis) {
  if (!radioReady_) {
    return;
  }
  TransmitEnd transmitEnd{};
  switch (radio_.poll(receivedFrame_, transmitEnd)) {
  case RadioEvent::TransmitDone:
    services_.recordTransmitEnd(transmitEnd.micros, nowMillis);
    reportReceptionFailure(transmitEnd.reception);
    break;
  case RadioEvent::FrameReceived:
    services_.receive(receivedFrame_, nowMillis, radio_.settings());
    break;
  case RadioEvent::None:
    break;
  }
}

void NodeApplication::serviceTransmitter(uint32_t nowMillis) {
  if (!radioReady_ || radio_.isTransmitting()) {
    return;
  }
  SettingsResult settingsResult{};
  if (radio_.applyDeferredSettings(settingsResult)) {
    reportSettingsChange(settingsResult);
  }
  const QueuedFrame *next = services_.nextFrame(nowMillis, radio_.settings());
  if (next == nullptr) {
    return;
  }
  const TransmitResult result = radio_.startTransmit(next->data, next->length);
  switch (result.status) {
  case TransmitStatus::ReceptionPending:
    return;
  case TransmitStatus::Failed:
    events_.error("radio", ErrorReason::RadioFailure, "transmit", result.errorCode);
    reportReceptionFailure(result.reception);
    services_.recordTransmitFailure();
    return;
  case TransmitStatus::Started:
    services_.recordTransmitStart(nowMillis, result.startMicros, radio_.settings());
    return;
  }
}

void NodeApplication::reportSettingsChange(const SettingsResult &result) {
  if (!result.apply.succeeded) {
    events_.error("radio", ErrorReason::RadioFailure, "apply", result.apply.code);
  }
  if (!result.restore.succeeded) {
    events_.error("radio", ErrorReason::RadioFailure, "restore", result.restore.code);
  }
  reportRadio();
  const RadioSettings &current = radio_.settings();
  events_.debug("radio %u/%u %+d dBm", current.spreadingFactor, current.bandwidthKhz,
                current.transmitPowerDbm);
  updateStatusLine();
}

void NodeApplication::reportReceptionFailure(const RadioStatus &reception) {
  if (!reception.succeeded) {
    events_.error("radio", ErrorReason::RadioFailure, "receive", reception.code);
  }
}

// ---------------------------------------------------------------------------------------------
// Console

void NodeApplication::serviceConsole(uint32_t nowMillis) {
  const CommandContext context{*this, services_, events_};
  bool overflowed = false;
  for (int command = 0; command < MAXIMUM_COMMANDS_PER_POLL; ++command) {
    if (!console_.readCommand(commandLine_, sizeof(commandLine_), overflowed)) {
      return;
    }
    executeCommandLine(commandLine_, overflowed, nowMillis, context);
  }
}

bool NodeApplication::isRadioStarted() const { return radioReady_; }

RadioSettings NodeApplication::requestedRadioSettings() const { return radio_.requestedSettings(); }

void NodeApplication::reportStatus(uint32_t nowMillis) {
  const NodeCounters counters{services_.queue.sentCount(), services_.receivedCount(),
                              events_.droppedLineCount(), ESP.getFreeHeap()};
  writeStatusEvent(events_, identity_.nodeId(), board_.model(), identity_.epoch(), counters);
  reportRadio();
  reportWireless();
  services_.presence.reportPresence(nowMillis);
  services_.activation.reportVirtualMachine();
  services_.transfer.reportTransfer();
  services_.presence.reportNeighbors(nowMillis);
}

void NodeApplication::reportRadio() {
  writeRadioEvent(events_, radio_.settings(), radio_.transceiverPower(), board_.model());
}

void NodeApplication::requestRadioSettings(const RadioSettings &settings) {
  SettingsResult result{};
  if (radio_.requestSettings(settings, result)) {
    reportSettingsChange(result);
  }
}

void NodeApplication::setWirelessEnabled(bool enabled) {
  if (!enabled) {
    wireless_.stop();
  } else if (!wireless_.start()) {
    events_.error("wifi", ErrorReason::WifiFailure, ACCESS_POINT_FAILURE);
  }
  serviceWirelessChange();
}

// ---------------------------------------------------------------------------------------------
// WiFi

void NodeApplication::serviceWirelessChange() {
  const WirelessChange change = wireless_.takeStateChange();
  if (change == WirelessChange::None) {
    return;
  }
  reportWireless();
  if (change == WirelessChange::Switched) {
    events_.debug("wifi %s", wireless_.isEnabled() ? "on" : "off");
  } else {
    events_.debug("wifi %u client(s)", wireless_.clientCount());
  }
  updateStatusLine();
}

void NodeApplication::reportWireless() {
  writeWifiEvent(events_, wireless_.isEnabled(), wireless_.ssid(), wireless_.channel(),
                 wireless_.clientCount());
}

void NodeApplication::updateStatusLine() {
  // Identifier, model, SF/BW, power and a mark when a WiFi client is connected, in one line of the
  // display.
  const RadioSettings &settings = radio_.settings();
  char text[DISPLAY_COLUMNS + 1];
  snprintf(text, sizeof(text), "%04X %s %u/%u %+d%s", identity_.nodeId(), board_.modelName(),
           settings.spreadingFactor, settings.bandwidthKhz, settings.transmitPowerDbm,
           wireless_.clientCount() > 0 ? "*" : "");
  display_.setStatusLine(text);
}

} // namespace firmware
