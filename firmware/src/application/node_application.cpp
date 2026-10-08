#include "node_application.h"

#include <Arduino.h>
#include <RadioLib.h>
#include <errno.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../configuration.h"
#include "../network/byte_order.h"
#include "../radio/time_on_air.h"

namespace firmware {

static constexpr size_t DEBUG_TEXT_CAPACITY = 64;
static constexpr size_t ERROR_DETAIL_CAPACITY = 48;
static constexpr size_t COMMAND_WORD_CAPACITY = 16;
static constexpr uint32_t NEIGHBOR_EXPIRY_CHECK_MS = 1000;
static constexpr int MAXIMUM_COMMANDS_PER_POLL = 2;

namespace {

enum class NumberParse : uint8_t { Valid, Invalid, OutOfRange };

} // namespace

static NumberParse parseUnsigned(const char *text, unsigned long minimum, unsigned long maximum,
                                 unsigned long &value) {
  if (text == nullptr || *text == '\0' || *text == '-' || *text == '+') {
    return NumberParse::Invalid;
  }
  char *end = nullptr;
  errno = 0;
  value = strtoul(text, &end, 10);
  if (errno != 0 || end == nullptr || *end != '\0') {
    return NumberParse::Invalid;
  }
  return value < minimum || value > maximum ? NumberParse::OutOfRange : NumberParse::Valid;
}

static bool parseNodeId(const char *text, uint16_t &id) {
  const size_t length = strlen(text);
  if (length == 0 || length > 4) {
    return false;
  }
  char *end = nullptr;
  const unsigned long value = strtoul(text, &end, 16);
  if (end == nullptr || *end != '\0' || value == 0x0000 || value == BROADCAST_NODE_ID) {
    return false;
  }
  id = static_cast<uint16_t>(value);
  return true;
}

static void copyFirstWord(const char *line, char *word, size_t capacity) {
  while (*line == ' ' || *line == '\t') {
    ++line;
  }
  size_t length = 0;
  while (line[length] != '\0' && line[length] != ' ' && line[length] != '\t' &&
         length + 1 < capacity) {
    word[length] = line[length];
    ++length;
  }
  word[length] = '\0';
}

static uint32_t roundUpToMillis(uint32_t micros) { return (micros + 999) / 1000; }

// ---------------------------------------------------------------------------------------------
// Start and main loop

void NodeApplication::begin() {
  registerCommands();
  board_.begin();
  serial_.begin(CONSOLE_BAUD_RATE);
  console_.begin(serial_, wireless_);
  display_.begin();
  identity_.begin();
  snprintf(accessPointName_, sizeof(accessPointName_), "J5-%04X", identity_.nodeId());

  const int16_t radioState = radio_.begin(board_, defaultRadioSettings());
  radioReady_ = radioState == RADIOLIB_ERR_NONE;
  const bool wirelessReady = wireless_.begin(accessPointName_, J5_ACCESS_POINT_PASSWORD,
                                             ACCESS_POINT_CHANNEL, ACCESS_POINT_MAXIMUM_CLIENTS);
  // The boot sequence below already reports the WiFi state.
  wireless_.takeClientChange();
  presence_.begin(millis());

  emitBoot();
  emitRadio();
  emitWifi();
  debug("boot %04X %s e%u", identity_.nodeId(), board_.modelName(), identity_.epoch());
  if (!board_.isFrontEndVerified()) {
    debug("front end not KCT8103L");
  }
  if (!radioReady_) {
    emitError("radio", "radio_failure", "begin", radioState);
  }
  if (!wirelessReady) {
    emitError("wifi", "wifi_failure", "access point did not start");
  }
  updateStatusLine();
}

void NodeApplication::poll() {
  const uint32_t now = millis();
  serviceRadio(now);
  serviceTransmitter(now);
  serviceConsole();
  serviceTimers(now);
  // Sending a frame to the display blocks for about 30 ms. Never while the radio is transmitting,
  // has frames waiting or expects an echo reply, so it returns to reception in time.
  if (!radio_.isTransmitting() && queueCount_ == 0 && !echo_.isPending()) {
    display_.poll(now);
  }
}

// ---------------------------------------------------------------------------------------------
// Radio

void NodeApplication::serviceRadio(uint32_t nowMillis) {
  if (!radioReady_) {
    return;
  }
  switch (radio_.poll(receivedFrame_)) {
  case RadioEvent::TransmitDone:
    onTransmitDone(nowMillis);
    break;
  case RadioEvent::FrameReceived:
    onFrameReceived(receivedFrame_, nowMillis);
    break;
  case RadioEvent::None:
    break;
  }
}

void NodeApplication::serviceTransmitter(uint32_t nowMillis) {
  if (!radioReady_ || radio_.isTransmitting()) {
    return;
  }
  if (hasPendingSettings_) {
    hasPendingSettings_ = false;
    applyRadioSettings(pendingSettings_);
  }
  if (queueCount_ == 0) {
    if (runs_.isFrameDue(nowMillis)) {
      enqueueTestFrame();
    } else if (presence_.isDue(nowMillis)) {
      enqueueHello();
      presence_.scheduleNext(nowMillis);
    }
  }
  if (queueCount_ == 0) {
    return;
  }

  OutgoingFrame &next = queue_[queueHead_];
  const int16_t state = radio_.startTransmit(next.data, next.length);
  if (state == RADIO_LINK_RECEPTION_PENDING) {
    return;
  }
  inFlight_ = next;
  queueHead_ = (queueHead_ + 1) % TRANSMIT_QUEUE_CAPACITY;
  --queueCount_;

  if (state != RADIOLIB_ERR_NONE) {
    emitError("radio", "radio_failure", "transmit", state);
    FrameHeader header{};
    readFrameHeader(inFlight_.data, inFlight_.length, header);
    if (header.type == static_cast<uint8_t>(MessageType::Test) && runs_.isSending()) {
      runs_.onFrameFailed();
    } else if (header.type == static_cast<uint8_t>(MessageType::EchoRequest)) {
      echo_.clear();
    }
    return;
  }
  hasInFlight_ = true;
  onTransmitStarted(nowMillis);
}

void NodeApplication::onTransmitStarted(uint32_t nowMillis) {
  FrameHeader header{};
  readFrameHeader(inFlight_.data, inFlight_.length, header);
  switch (static_cast<MessageType>(header.type)) {
  case MessageType::EchoRequest:
    echo_.markTransmitting(radio_.transmitStartMicros(), nowMillis,
                           computeTimeOnAirMicros(inFlight_.length, radio_.settings()));
    break;
  case MessageType::Test:
    runs_.onFrameStarted(radio_.transmitStartMicros());
    break;
  case MessageType::EchoReply:
    if (echoReply_.pending) {
      // The reply is already on the air, so writing the event does not delay it.
      echoReply_.pending = false;
      JsonDocument &event = console_.beginEvent("echo_served");
      setNodeId(event["src"], echoReply_.source);
      event["n"] = echoReply_.number;
      event["size"] = echoReply_.size;
      event["rssi"] = roundToDecimals(echoReply_.rssi, 1);
      event["snr"] = roundToDecimals(echoReply_.snr, 2);
      console_.writeEvent();
    }
    break;
  case MessageType::Hello:
    break;
  }
}

void NodeApplication::onTransmitDone(uint32_t nowMillis) {
  if (!hasInFlight_) {
    return;
  }
  hasInFlight_ = false;
  ++transmittedCount_;
  lastTransmitted_ = inFlight_;
  hasLastTransmitted_ = true;

  FrameHeader header{};
  readFrameHeader(inFlight_.data, inFlight_.length, header);
  const uint32_t measured = radio_.measuredTimeOnAirMicros();
  const bool isTest = header.type == static_cast<uint8_t>(MessageType::Test);

  JsonDocument &event = console_.beginEvent("tx");
  event["type"] = messageTypeName(header.type);
  setNodeId(event["dst"], header.destination);
  event["seq"] = header.sequence;
  event["size"] = inFlight_.length;
  event["toa"] = measured;
  event["toa_calc"] = computeTimeOnAirMicros(inFlight_.length, radio_.settings());
  if (isTest) {
    TestFields fields{};
    TestRunService::decodePayload(inFlight_.data + FRAME_HEADER_SIZE,
                                  inFlight_.length - FRAME_OVERHEAD, fields);
    event["run"] = fields.run;
    event["index"] = fields.index;
  }
  console_.writeEvent();

  if (isTest && runs_.isSending() && runs_.sender().frameInFlight) {
    const int64_t endMicros = radio_.transmitStartMicros() + measured;
    if (runs_.onFrameSent(endMicros, nowMillis)) {
      finishSenderRun(runs_.sender().stopRequested);
    }
  }
}

void NodeApplication::onFrameReceived(const ReceivedFrame &frame, uint32_t nowMillis) {
  if (!frame.integrityVerified) {
    emitDrop("crc", frame);
    return;
  }
  FrameHeader header{};
  const uint8_t *payload = nullptr;
  size_t payloadLength = 0;
  switch (decodeFrame(frame.data, frame.length, header, payload, payloadLength)) {
  case FrameCheck::TooShort:
    emitDrop("short", frame);
    return;
  case FrameCheck::InvalidTag:
    emitDrop("tag", frame);
    return;
  case FrameCheck::Valid:
    break;
  }
  if (!isKnownMessageType(header.type)) {
    emitDrop("type", frame);
    return;
  }
  if (!isPayloadValid(header.type, payload, payloadLength)) {
    emitDrop("body", frame);
    return;
  }
  if (header.source == identity_.nodeId()) {
    JsonDocument &event = console_.beginEvent("id_conflict");
    event["epoch"] = header.epoch;
    event["seq"] = header.sequence;
    event["rssi"] = roundToDecimals(frame.rssi, 1);
    event["snr"] = roundToDecimals(frame.snr, 2);
    console_.writeEvent();
    debug("id conflict");
    return;
  }
  if (!duplicates_.acceptIfNew(header.source, header.epoch, header.sequence, nowMillis)) {
    JsonDocument &event = console_.beginEvent("duplicate");
    setNodeId(event["src"], header.source);
    event["epoch"] = header.epoch;
    event["seq"] = header.sequence;
    event["type"] = messageTypeName(header.type);
    console_.writeEvent();
    return;
  }

  ++receivedCount_;
  neighbors_.recordFrame(header.source, frame.rssi, frame.snr, nowMillis);
  if (header.destination != BROADCAST_NODE_ID && header.destination != identity_.nodeId()) {
    return;
  }

  switch (static_cast<MessageType>(header.type)) {
  case MessageType::Hello:
    handleHello(header, payload, payloadLength, frame);
    break;
  case MessageType::EchoRequest:
    handleEchoRequest(header, payload, payloadLength, frame);
    break;
  case MessageType::EchoReply:
    handleEchoReply(header, payload, payloadLength, frame);
    break;
  case MessageType::Test:
    handleTestFrame(header, payload, payloadLength, frame, nowMillis);
    break;
  }
}

bool NodeApplication::isPayloadValid(uint8_t type, const uint8_t *payload, size_t length) const {
  switch (static_cast<MessageType>(type)) {
  case MessageType::Hello: {
    HelloContent content;
    return PresenceService::decodePayload(payload, length, content);
  }
  case MessageType::EchoRequest:
  case MessageType::EchoReply:
    return length >= MINIMUM_ECHO_SIZE;
  case MessageType::Test: {
    TestFields fields;
    return TestRunService::decodePayload(payload, length, fields);
  }
  }
  return false;
}

void NodeApplication::handleHello(const FrameHeader &header, const uint8_t *payload, size_t length,
                                  const ReceivedFrame &frame) {
  HelloContent content{};
  PresenceService::decodePayload(payload, length, content);
  neighbors_.recordHello(header.source, content.model, content.version, content.transmitted);

  JsonDocument &event = console_.beginEvent("hello");
  setNodeId(event["src"], header.source);
  event["epoch"] = header.epoch;
  event["seq"] = header.sequence;
  event["model"] = boardModelName(content.model);
  event["version"] = content.version;
  event["tx"] = content.transmitted;
  event["rssi"] = roundToDecimals(frame.rssi, 1);
  event["snr"] = roundToDecimals(frame.snr, 2);
  event["ferr"] = lroundf(frame.frequencyError);
  JsonArray neighbors = event["neighbors"].to<JsonArray>();
  for (uint8_t index = 0; index < content.neighborCount; ++index) {
    const HelloNeighborEntry &entry = content.neighbors[index];
    JsonObject neighbor = neighbors.add<JsonObject>();
    setNodeId(neighbor["id"], entry.id);
    neighbor["rssi"] = entry.rssi;
    neighbor["snr"] = roundToDecimals(entry.snr, 2);
  }
  console_.writeEvent();
  debug("hello %04X %.0f dBm", header.source, frame.rssi);
}

void NodeApplication::handleEchoRequest(const FrameHeader &header, const uint8_t *payload,
                                        size_t length, const ReceivedFrame &frame) {
  const uint16_t number = readUint16(payload);
  uint8_t reply[MAXIMUM_PAYLOAD_SIZE];
  const size_t replyLength =
      EchoService::encodeReply(number, frame.rssi, frame.snr, static_cast<uint16_t>(length), reply);
  if (!enqueueFrame(MessageType::EchoReply, header.source, reply, replyLength, true)) {
    return;
  }
  echoReply_.pending = true;
  echoReply_.source = header.source;
  echoReply_.number = number;
  echoReply_.size = static_cast<uint16_t>(length);
  echoReply_.rssi = frame.rssi;
  echoReply_.snr = frame.snr;
}

void NodeApplication::handleEchoReply(const FrameHeader &header, const uint8_t *payload,
                                      size_t length, const ReceivedFrame &frame) {
  const uint16_t number = readUint16(payload);
  if (!echo_.isReplyExpected(header.source, number)) {
    return;
  }
  float remoteRssi = 0.0f;
  float remoteSnr = 0.0f;
  EchoService::decodeReplyQuality(payload, remoteRssi, remoteSnr);
  const int64_t roundTripMicros = frame.receivedAtMicros - echo_.startMicros();

  JsonDocument &event = console_.beginEvent("echo");
  setNodeId(event["dst"], header.source);
  event["n"] = number;
  event["size"] = length;
  event["rtt"] = roundTripMicros;
  event["rssi"] = roundToDecimals(frame.rssi, 1);
  event["snr"] = roundToDecimals(frame.snr, 2);
  event["remote_rssi"] = roundToDecimals(remoteRssi, 1);
  event["remote_snr"] = roundToDecimals(remoteSnr, 2);
  console_.writeEvent();
  echo_.clear();
  debug("echo %04X %.1f ms", header.source, roundTripMicros / 1000.0);
}

void NodeApplication::handleTestFrame(const FrameHeader &header, const uint8_t *payload,
                                      size_t length, const ReceivedFrame &frame,
                                      uint32_t nowMillis) {
  TestFields fields{};
  TestRunService::decodePayload(payload, length, fields);

  // A new run from the same source closes the previous one.
  ReceiverRun *previous = runs_.findActiveRun(header.source);
  if (previous != nullptr && previous->run != fields.run) {
    finishReceiverRun(*previous, "timeout");
  }

  bool opened = false;
  bool completed = false;
  const uint32_t timeOnAirMillis =
      roundUpToMillis(computeTimeOnAirMicros(frame.length, radio_.settings()));
  ReceiverRun *run = runs_.recordTestFrame(header.source, fields, frame.rssi, frame.snr, nowMillis,
                                           timeOnAirMillis, opened, completed);

  JsonDocument &event = console_.beginEvent("test_rx");
  setNodeId(event["src"], header.source);
  event["run"] = fields.run;
  event["index"] = fields.index;
  event["count"] = fields.count;
  event["size"] = length;
  event["rssi"] = roundToDecimals(frame.rssi, 1);
  event["snr"] = roundToDecimals(frame.snr, 2);
  event["ferr"] = lroundf(frame.frequencyError);
  console_.writeEvent();

  if (run == nullptr) {
    return;
  }
  if (opened) {
    debug("run %u from %04X", fields.run, header.source);
    updateSuspension(nowMillis);
  }
  if (completed) {
    finishReceiverRun(*run, "complete");
  }
}

// ---------------------------------------------------------------------------------------------
// Transmission queue

NodeApplication::OutgoingFrame *NodeApplication::reserveQueueSlot(bool priority) {
  if (queueCount_ >= TRANSMIT_QUEUE_CAPACITY) {
    return nullptr;
  }
  size_t index = 0;
  if (priority) {
    queueHead_ = (queueHead_ + TRANSMIT_QUEUE_CAPACITY - 1) % TRANSMIT_QUEUE_CAPACITY;
    index = queueHead_;
  } else {
    index = (queueHead_ + queueCount_) % TRANSMIT_QUEUE_CAPACITY;
  }
  ++queueCount_;
  return &queue_[index];
}

bool NodeApplication::enqueueFrame(MessageType type, uint16_t destination, const uint8_t *payload,
                                   size_t payloadLength, bool priority) {
  OutgoingFrame *slot = reserveQueueSlot(priority);
  if (slot == nullptr) {
    return false;
  }
  FrameHeader header{};
  header.type = static_cast<uint8_t>(type);
  header.source = identity_.nodeId();
  header.destination = destination;
  identity_.assignSequence(header.epoch, header.sequence);
  slot->length = encodeFrame(header, payload, payloadLength, slot->data);
  return true;
}

bool NodeApplication::enqueueRawFrame(const uint8_t *data, size_t length, bool priority) {
  OutgoingFrame *slot = reserveQueueSlot(priority);
  if (slot == nullptr) {
    return false;
  }
  memcpy(slot->data, data, length);
  slot->length = length;
  return true;
}

void NodeApplication::enqueueHello() {
  HelloContent content{};
  content.model = static_cast<uint8_t>(board_.model());
  content.version = 0;
  content.transmitted = transmittedCount_;
  const size_t count = neighbors_.count();
  content.neighborCount =
      static_cast<uint8_t>(count < MAXIMUM_NEIGHBORS ? count : MAXIMUM_NEIGHBORS);
  for (uint8_t index = 0; index < content.neighborCount; ++index) {
    const Neighbor &neighbor = neighbors_.at(index);
    content.neighbors[index].id = neighbor.id;
    content.neighbors[index].rssi = static_cast<int16_t>(lroundf(neighbor.rssi));
    content.neighbors[index].snr = neighbor.snr;
  }
  uint8_t payload[MAXIMUM_PAYLOAD_SIZE];
  const size_t length = PresenceService::encodePayload(content, payload);
  enqueueFrame(MessageType::Hello, BROADCAST_NODE_ID, payload, length, false);
}

void NodeApplication::enqueueTestFrame() {
  uint8_t payload[MAXIMUM_PAYLOAD_SIZE];
  const size_t length = runs_.buildNextPayload(payload);
  if (!enqueueFrame(MessageType::Test, BROADCAST_NODE_ID, payload, length, false)) {
    runs_.onFrameFailed();
  }
}

// ---------------------------------------------------------------------------------------------
// Console

void NodeApplication::registerCommands() {
  // The description of each command is its usage: the help lists it and usage errors carry it.
  helpCommand_ = commandInterpreter_.addCommand("help");
  helpCommand_.setDescription("help");
  statusCommand_ = commandInterpreter_.addCommand("status");
  statusCommand_.setDescription("status");
  radioCommand_ = commandInterpreter_.addBoundlessCommand("radio");
  radioCommand_.setDescription(
      "radio | radio reset | radio <key> <value> ... (freq sf bw cr preamble sync power lna)");
  echoCommand_ = commandInterpreter_.addCommand("echo");
  echoCommand_.addPositionalArgument("id");
  echoCommand_.addPositionalArgument("size", "16");
  echoCommand_.setDescription("echo <id> [size]");
  runCommand_ = commandInterpreter_.addCommand("run");
  runCommand_.addPositionalArgument("count");
  runCommand_.addPositionalArgument("size", "");
  runCommand_.addPositionalArgument("interval", "");
  runCommand_.setDescription("run <count> <size> <interval_ms> | run stop");
  wifiCommand_ = commandInterpreter_.addCommand("wifi");
  wifiCommand_.addPositionalArgument("state");
  wifiCommand_.setDescription("wifi on|off");
  resendCommand_ = commandInterpreter_.addCommand("resend");
  resendCommand_.setDescription("resend");
}

void NodeApplication::serviceConsole() {
  char line[CONSOLE_LINE_CAPACITY + 1];
  bool overflowed = false;
  for (int command = 0; command < MAXIMUM_COMMANDS_PER_POLL; ++command) {
    if (!console_.readCommand(line, sizeof(line), overflowed)) {
      return;
    }
    if (overflowed) {
      char word[COMMAND_WORD_CAPACITY];
      copyFirstWord(line, word, sizeof(word));
      emitError(word, "line_too_long");
      continue;
    }
    executeCommand(line);
  }
}

void NodeApplication::executeCommand(const char *line) {
  commandInterpreter_.parse(line);
  while (commandInterpreter_.errored()) {
    reportCommandError(commandInterpreter_.getError(), line);
  }
  while (commandInterpreter_.available()) {
    const Command command = commandInterpreter_.getCmd();
    if (command == helpCommand_) {
      commandHelp();
    } else if (command == statusCommand_) {
      commandStatus();
    } else if (command == radioCommand_) {
      commandRadio(command);
    } else if (command == echoCommand_) {
      commandEcho(command);
    } else if (command == runCommand_) {
      commandRun(command);
    } else if (command == wifiCommand_) {
      commandWifi(command);
    } else if (command == resendCommand_) {
      commandResend();
    }
  }
}

void NodeApplication::reportCommandError(const CommandError &error, const char *line) {
  char word[COMMAND_WORD_CAPACITY];
  copyFirstWord(line, word, sizeof(word));
  switch (error.getType()) {
  case CommandErrorType::EMPTY_LINE:
  case CommandErrorType::PARSE_SUCCESSFUL:
    return;
  case CommandErrorType::COMMAND_NOT_FOUND:
    emitError(word, "unknown_command");
    return;
  default:
    emitError(word, "usage", error.getCommand().getDescription().c_str());
    return;
  }
}

void NodeApplication::commandHelp() {
  const Command *const commands[] = {&helpCommand_, &statusCommand_, &radioCommand_, &echoCommand_,
                                     &runCommand_,  &wifiCommand_,   &resendCommand_};
  console_.writeDebug("commands:");
  for (const Command *command : commands) {
    String usage = "  ";
    usage += command->getDescription();
    console_.writeDebug(usage.c_str());
  }
}

void NodeApplication::commandStatus() {
  JsonDocument &status = console_.beginEvent("status");
  setNodeId(status["id"], identity_.nodeId());
  status["model"] = board_.modelName();
  status["epoch"] = identity_.epoch();
  status["tx"] = transmittedCount_;
  status["rx"] = receivedCount_;
  status["dropped"] = console_.droppedLineCount();
  status["heap"] = ESP.getFreeHeap();
  console_.writeEvent();
  emitRadio();
  emitWifi();

  const uint32_t now = millis();
  for (size_t index = 0; index < neighbors_.count(); ++index) {
    const Neighbor &neighbor = neighbors_.at(index);
    JsonDocument &event = console_.beginEvent("neighbor");
    setNodeId(event["id"], neighbor.id);
    event["model"] = boardModelName(neighbor.model);
    event["version"] = neighbor.version;
    event["tx"] = neighbor.transmitted;
    event["rssi"] = roundToDecimals(neighbor.rssi, 1);
    event["snr"] = roundToDecimals(neighbor.snr, 2);
    event["age"] = now - neighbor.lastHeardMillis;
    console_.writeEvent();
  }
}

void NodeApplication::commandRadio(const Command &command) {
  const int argumentCount = command.countArgs();
  if (argumentCount == 0) {
    emitRadio();
    return;
  }
  if (isRunActive()) {
    emitError("radio", "busy");
    return;
  }
  if (!radioReady_) {
    emitError("radio", "radio_failure", "radio not started");
    return;
  }
  if (argumentCount == 1 && command.getArgument(0).getValue() == "reset") {
    requestRadioSettings(defaultRadioSettings());
    return;
  }
  if (argumentCount % 2 != 0) {
    emitError("radio", "usage", command.getDescription().c_str());
    return;
  }

  RadioSettings candidate = hasPendingSettings_ ? pendingSettings_ : radio_.settings();
  char detail[ERROR_DETAIL_CAPACITY];
  for (int index = 0; index + 1 < argumentCount; index += 2) {
    const String key = command.getArgument(index).getValue();
    const String value = command.getArgument(index + 1).getValue();
    const SettingUpdate update =
        updateRadioSetting(candidate, key.c_str(), value.c_str(), board_, detail, sizeof(detail));
    if (update != SettingUpdate::Accepted) {
      emitError("radio", settingUpdateReason(update), detail);
      return;
    }
  }
  requestRadioSettings(candidate);
}

void NodeApplication::commandEcho(const Command &command) {
  if (isRunActive() || echo_.isPending()) {
    emitError("echo", "busy");
    return;
  }
  if (!radioReady_) {
    emitError("echo", "radio_failure", "radio not started");
    return;
  }
  uint16_t destination = 0;
  const String id = command.getArgument("id").getValue();
  if (!parseNodeId(id.c_str(), destination) || destination == identity_.nodeId()) {
    emitError("echo", "usage", "echo <id> [size] with the id of another node");
    return;
  }
  unsigned long size = 0;
  const String sizeText = command.getArgument("size").getValue();
  const NumberParse parse =
      parseUnsigned(sizeText.c_str(), MINIMUM_ECHO_SIZE, MAXIMUM_PAYLOAD_SIZE, size);
  if (parse == NumberParse::Invalid) {
    emitError("echo", "usage", command.getDescription().c_str());
    return;
  }
  if (parse == NumberParse::OutOfRange) {
    emitError("echo", "out_of_range", "size 4..239");
    return;
  }

  const uint16_t number = ++echoCounter_;
  uint8_t payload[MAXIMUM_PAYLOAD_SIZE];
  const size_t length = EchoService::encodeRequest(number, static_cast<uint16_t>(size), payload);
  if (!enqueueFrame(MessageType::EchoRequest, destination, payload, length, false)) {
    emitError("echo", "busy", "transmit queue full");
    return;
  }
  echo_.prepare(destination, number, static_cast<uint16_t>(size), millis());
}

void NodeApplication::commandRun(const Command &command) {
  const String countText = command.getArgument("count").getValue();
  const String sizeText = command.getArgument("size").getValue();
  const String intervalText = command.getArgument("interval").getValue();
  if (countText == "stop" && sizeText.length() == 0 && intervalText.length() == 0) {
    if (!runs_.isSending()) {
      emitError("run", "usage", "no run in progress");
      return;
    }
    runs_.requestStop();
    return;
  }
  if (isRunActive() || echo_.isPending()) {
    emitError("run", "busy");
    return;
  }
  if (!radioReady_) {
    emitError("run", "radio_failure", "radio not started");
    return;
  }

  unsigned long count = 0;
  unsigned long size = 0;
  unsigned long interval = 0;
  const NumberParse countParse = parseUnsigned(countText.c_str(), 1, 65535, count);
  const NumberParse sizeParse =
      parseUnsigned(sizeText.c_str(), MINIMUM_TEST_SIZE, MAXIMUM_PAYLOAD_SIZE, size);
  const NumberParse intervalParse =
      parseUnsigned(intervalText.c_str(), 0, MAXIMUM_RUN_INTERVAL_MS, interval);
  if (countParse == NumberParse::Invalid || sizeParse == NumberParse::Invalid ||
      intervalParse == NumberParse::Invalid) {
    emitError("run", "usage", command.getDescription().c_str());
    return;
  }
  if (countParse == NumberParse::OutOfRange) {
    emitError("run", "out_of_range", "count 1..65535");
    return;
  }
  if (sizeParse == NumberParse::OutOfRange) {
    emitError("run", "out_of_range", "size 8..239");
    return;
  }
  if (intervalParse == NumberParse::OutOfRange) {
    emitError("run", "out_of_range", "interval 0..60000");
    return;
  }

  const uint32_t now = millis();
  const uint16_t run = runs_.startSending(static_cast<uint16_t>(count), static_cast<uint16_t>(size),
                                          static_cast<uint16_t>(interval), now);
  JsonDocument &event = console_.beginEvent("run_start");
  event["run"] = run;
  event["count"] = count;
  event["size"] = size;
  event["interval"] = interval;
  console_.writeEvent();
  debug("run %u start %lux%lu", run, count, size);
  updateSuspension(now);
}

void NodeApplication::commandWifi(const Command &command) {
  const String state = command.getArgument("state").getValue();
  if (state == "on") {
    if (!wireless_.begin(accessPointName_, J5_ACCESS_POINT_PASSWORD, ACCESS_POINT_CHANNEL,
                         ACCESS_POINT_MAXIMUM_CLIENTS)) {
      emitError("wifi", "wifi_failure", "access point did not start");
    }
  } else if (state == "off") {
    wireless_.end();
  } else {
    emitError("wifi", "usage", command.getDescription().c_str());
    return;
  }
  wireless_.takeClientChange();
  emitWifi();
  debug("wifi %s", wireless_.isEnabled() ? "on" : "off");
  updateStatusLine();
}

void NodeApplication::commandResend() {
  if (isRunActive()) {
    emitError("resend", "busy");
    return;
  }
  if (!radioReady_) {
    emitError("resend", "radio_failure", "radio not started");
    return;
  }
  if (!hasLastTransmitted_) {
    emitError("resend", "usage", "nothing to resend");
    return;
  }
  if (!enqueueRawFrame(lastTransmitted_.data, lastTransmitted_.length, false)) {
    emitError("resend", "busy", "transmit queue full");
  }
}

bool NodeApplication::isRunActive() const { return runs_.isSending() || runs_.isReceiving(); }

void NodeApplication::requestRadioSettings(const RadioSettings &settings) {
  // A change in the middle of a transmission would cut it: wait until it ends.
  if (radio_.isTransmitting()) {
    pendingSettings_ = settings;
    hasPendingSettings_ = true;
    return;
  }
  applyRadioSettings(settings);
}

void NodeApplication::applyRadioSettings(const RadioSettings &settings) {
  const int16_t state = radio_.applySettings(settings);
  if (state != RADIOLIB_ERR_NONE) {
    emitError("radio", "radio_failure", "apply", state);
  }
  emitRadio();
  const RadioSettings &current = radio_.settings();
  debug("radio %u/%u %+d dBm", current.spreadingFactor, current.bandwidthKhz,
        current.transmitPowerDbm);
  updateStatusLine();
}

// ---------------------------------------------------------------------------------------------
// Timers

void NodeApplication::serviceTimers(uint32_t nowMillis) {
  if (echo_.isPending() && echo_.hasExpired(nowMillis)) {
    JsonDocument &event = console_.beginEvent("echo_lost");
    setNodeId(event["dst"], echo_.destination());
    event["n"] = echo_.number();
    event["size"] = echo_.size();
    event["timeout"] = echo_.timeoutMillis();
    console_.writeEvent();
    debug("echo %04X lost", echo_.destination());
    echo_.clear();
  }

  for (ReceiverRun *run = runs_.findExpiredRun(nowMillis); run != nullptr;
       run = runs_.findExpiredRun(nowMillis)) {
    finishReceiverRun(*run, "timeout");
  }

  if (runs_.isSending() && runs_.sender().stopRequested && !runs_.sender().frameInFlight) {
    finishSenderRun(true);
  }

  if (nowMillis - lastExpiryMillis_ >= NEIGHBOR_EXPIRY_CHECK_MS) {
    lastExpiryMillis_ = nowMillis;
    neighbors_.expire(nowMillis);
  }

  if (wireless_.takeClientChange()) {
    emitWifi();
    debug("wifi %u client(s)", wireless_.clientCount());
    updateStatusLine();
  }

  updateSuspension(nowMillis);
}

void NodeApplication::finishSenderRun(bool aborted) {
  const SenderRun &run = runs_.sender();
  JsonDocument &event = console_.beginEvent("run_done");
  event["run"] = run.run;
  event["count"] = run.count;
  event["sent"] = run.sent;
  event["duration"] = run.sent > 0 ? run.lastEndMicros - run.firstStartMicros : 0;
  event["aborted"] = aborted;
  console_.writeEvent();
  debug("run %u done %u/%u", run.run, run.sent, run.count);
  runs_.finishSending();
  updateSuspension(millis());
}

void NodeApplication::finishReceiverRun(ReceiverRun &run, const char *reason) {
  JsonDocument &event = console_.beginEvent("run_end");
  setNodeId(event["src"], run.source);
  event["run"] = run.run;
  event["count"] = run.count;
  event["received"] = run.received;
  event["pdr"] = roundToDecimals(static_cast<double>(run.received) / run.count, 4);
  if (run.received > 0) {
    event["rssi_avg"] = roundToDecimals(run.rssiSum / run.received, 1);
    event["rssi_min"] = roundToDecimals(run.rssiMinimum, 1);
    event["rssi_max"] = roundToDecimals(run.rssiMaximum, 1);
    event["snr_avg"] = roundToDecimals(run.snrSum / run.received, 2);
  } else {
    event["rssi_avg"] = nullptr;
    event["rssi_min"] = nullptr;
    event["rssi_max"] = nullptr;
    event["snr_avg"] = nullptr;
  }
  event["first"] = run.firstMillis;
  event["last"] = run.lastMillis;
  event["reason"] = reason;
  console_.writeEvent();
  debug("run %u end %u/%u", run.run, run.received, run.count);
  runs_.closeRun(run);
  updateSuspension(millis());
}

void NodeApplication::updateSuspension(uint32_t nowMillis) {
  const bool active = isRunActive();
  presence_.setSuspended(active, nowMillis);
  display_.setSuspended(active);
}

// ---------------------------------------------------------------------------------------------
// Events and debug text

void NodeApplication::emitBoot() {
  JsonDocument &event = console_.beginEvent("boot");
  setNodeId(event["id"], identity_.nodeId());
  event["model"] = board_.modelName();
  event["epoch"] = identity_.epoch();
  event["firmware"] = FIRMWARE_VERSION;
  event["protocol"] = PROTOCOL_VERSION;
  event["key"] = strcmp(J5_NETWORK_KEY, DEFAULT_NETWORK_KEY) == 0 ? "default" : "custom";
  console_.writeEvent();
}

void NodeApplication::emitRadio() {
  const RadioSettings &settings = radio_.settings();
  JsonDocument &event = console_.beginEvent("radio");
  event["freq"] = roundToDecimals(settings.frequencyMhz, 3);
  event["sf"] = settings.spreadingFactor;
  event["bw"] = settings.bandwidthKhz;
  event["cr"] = settings.codingRateDenominator;
  event["preamble"] = settings.preambleLength;
  event["sync"] = settings.syncWord;
  event["power"] = settings.transmitPowerDbm;
  event["chip"] = radio_.transceiverPower();
  if (board_.hasLowNoiseAmplifier()) {
    event["lna"] = settings.lowNoiseAmplifierEnabled ? "on" : "bypass";
  } else {
    event["lna"] = nullptr;
  }
  console_.writeEvent();
}

void NodeApplication::emitWifi() {
  JsonDocument &event = console_.beginEvent("wifi");
  event["state"] = wireless_.isEnabled() ? "on" : "off";
  event["ssid"] = accessPointName_;
  event["channel"] = ACCESS_POINT_CHANNEL;
  event["clients"] = wireless_.clientCount();
  console_.writeEvent();
}

void NodeApplication::emitError(const char *command, const char *reason, const char *detail,
                                int16_t code) {
  JsonDocument &event = console_.beginEvent("error");
  event["cmd"] = command;
  event["reason"] = reason;
  if (detail != nullptr && detail[0] != '\0') {
    event["detail"] = detail;
  }
  if (code != 0) {
    event["code"] = code;
  }
  console_.writeEvent();
  debug("error %s %s", command, reason);
}

void NodeApplication::emitDrop(const char *reason, const ReceivedFrame &frame) {
  JsonDocument &event = console_.beginEvent("drop");
  event["reason"] = reason;
  event["size"] = frame.length;
  event["rssi"] = roundToDecimals(frame.rssi, 1);
  event["snr"] = roundToDecimals(frame.snr, 2);
  console_.writeEvent();
}

void NodeApplication::debug(const char *format, ...) {
  char text[DEBUG_TEXT_CAPACITY];
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(text, sizeof(text), format, arguments);
  va_end(arguments);
  console_.writeDebug(text);
  display_.appendLine(text);
}

void NodeApplication::updateStatusLine() {
  // Fits the 21 columns of the display: identifier, model, SF/BW, power and a mark when a WiFi
  // client is connected.
  const RadioSettings &settings = radio_.settings();
  char text[DISPLAY_COLUMNS + 1];
  snprintf(text, sizeof(text), "%04X %s %u/%u %+d%s", identity_.nodeId(), board_.modelName(),
           settings.spreadingFactor, settings.bandwidthKhz, settings.transmitPowerDbm,
           wireless_.clientCount() > 0 ? "*" : "");
  display_.setStatusLine(text);
}

} // namespace firmware
