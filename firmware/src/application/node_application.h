#ifndef J5_NODE_APPLICATION_H
#define J5_NODE_APPLICATION_H

#include <stddef.h>
#include <stdint.h>

#include "../board/board_pin_port.h"
#include "../board/board_support.h"
#include "../console/command_line.h"
#include "../console/console.h"
#include "../console/event_sink.h"
#include "../console/serial_transport.h"
#include "../console/wireless_transport.h"
#include "../display/debug_display.h"
#include "../network/node_identity.h"
#include "../protocol/protocol_contract.h"
#include "../radio/radio_link.h"
#include "../radio/radio_settings.h"
#include "console_commands.h"
#include "node_services.h"

namespace firmware {

// The node: the hardware, the services and the main loop. Each pass reads the clock once and
// hands that reading to every module it serves.
class NodeApplication : private CommandTarget {
public:
  void begin();
  void poll();

private:
  // Radio. What goes out and what a received frame does are the rules of NodeServices; the node
  // moves the frames between them and the radio.
  void serviceRadio(uint32_t nowMillis);
  void serviceTransmitter(uint32_t nowMillis);
  void reportSettingsChange(const SettingsResult &result);
  // The radio did not go back to reception after a transmission or a refused one.
  void reportReceptionFailure(const RadioStatus &reception);

  // A redraw of the display blocks for about 30 ms, so it waits while the node is suspended or the
  // radio has work: a transmission, frames queued, an echo reply expected or a burst.
  bool isDisplayRedrawAllowed(uint32_t nowMillis) const;

  // Console. The commands themselves are in console_commands.cpp; they act on the services and
  // ask the node, through CommandTarget, for what spans the hardware.
  void serviceConsole(uint32_t nowMillis);
  bool isRadioStarted() const override;
  RadioSettings requestedRadioSettings() const override;
  void reportStatus(uint32_t nowMillis) override;
  void reportRadio() override;
  void requestRadioSettings(const RadioSettings &settings) override;
  void setWirelessEnabled(bool enabled) override;

  // The wifi event and its debug text, after any change of the access point.
  void serviceWirelessChange();

  void reportWireless();
  void updateStatusLine();

  BoardSupport board_;
  BoardPinPort pins_;
  NodeIdentity identity_;
  RadioLink radio_;
  NodeServices services_;
  SerialTransport serial_;
  WirelessTransport wireless_;
  DebugDisplay display_;
  Console console_;
  EventSink events_;

  ReceivedFrame receivedFrame_ = {};

  bool radioReady_ = false;
  char commandLine_[MAXIMUM_COMMAND_LINE_LENGTH + 1] = {};
};

} // namespace firmware

#endif
