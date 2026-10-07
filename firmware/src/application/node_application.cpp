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
#include "../console/event_writer.h"
#include "../network/byte_order.h"
#include "../radio/time_on_air.h"

namespace j5 {

namespace {

constexpr size_t MAXIMUM_COMMAND_TOKENS = 18;
constexpr size_t COMMAND_TOKEN_OVERFLOW = MAXIMUM_COMMAND_TOKENS + 1;
constexpr size_t DEBUG_TEXT_CAPACITY = 64;
constexpr size_t ERROR_DETAIL_CAPACITY = 48;
constexpr uint32_t NEIGHBOR_EXPIRY_CHECK_MS = 1000;
constexpr int MAXIMUM_COMMANDS_PER_POLL = 2;

enum class NumberParse : uint8_t { Valid, Invalid, OutOfRange };

size_t tokenize(char *line, char **tokens) {
  size_t count = 0;
  char *context = nullptr;
  for (char *token = strtok_r(line, " \t", &context); token != nullptr;
       token = strtok_r(nullptr, " \t", &context)) {
    if (count == MAXIMUM_COMMAND_TOKENS) {
      return COMMAND_TOKEN_OVERFLOW;
    }
    tokens[count++] = token;
  }
  return count;
}

NumberParse parseUnsigned(const char *text, unsigned long minimum, unsigned long maximum,
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

bool parseNodeId(const char *text, uint16_t &id) {
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

uint32_t roundUpToMillis(uint32_t micros) { return (micros + 999) / 1000; }

} // namespace

// ---------------------------------------------------------------------------------------------
// Start and main loop

void NodeApplication::begin() {
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
      EventWriter event("echo_served");
      event.nodeId("src", echoReply_.source)
          .unsignedInteger("n", echoReply_.number)
          .unsignedInteger("size", echoReply_.size)
          .decimal("rssi", echoReply_.rssi, 1)
          .decimal("snr", echoReply_.snr, 2);
      console_.writeEvent(event);
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

  EventWriter event("tx");
  event.text("type", messageTypeName(header.type))
      .nodeId("dst", header.destination)
      .unsignedInteger("seq", header.sequence)
      .unsignedInteger("size", inFlight_.length)
      .unsignedInteger("toa", measured)
      .unsignedInteger("toa_calc", computeTimeOnAirMicros(inFlight_.length, radio_.settings()));
  if (isTest) {
    TestFields fields{};
    TestRunService::decodePayload(inFlight_.data + FRAME_HEADER_SIZE,
                                  inFlight_.length - FRAME_OVERHEAD, fields);
    event.unsignedInteger("run", fields.run).unsignedInteger("index", fields.index);
  }
  console_.writeEvent(event);

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
    EventWriter event("id_conflict");
    event.unsignedInteger("epoch", header.epoch)
        .unsignedInteger("seq", header.sequence)
        .decimal("rssi", frame.rssi, 1)
        .decimal("snr", frame.snr, 2);
    console_.writeEvent(event);
    debug("id conflict");
    return;
  }
  if (!duplicates_.acceptIfNew(header.source, header.epoch, header.sequence, nowMillis)) {
    EventWriter event("duplicate");
    event.nodeId("src", header.source)
        .unsignedInteger("epoch", header.epoch)
        .unsignedInteger("seq", header.sequence)
        .text("type", messageTypeName(header.type));
    console_.writeEvent(event);
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

  EventWriter event("hello");
  event.nodeId("src", header.source)
      .unsignedInteger("epoch", header.epoch)
      .unsignedInteger("seq", header.sequence)
      .text("model", boardModelName(content.model))
      .unsignedInteger("version", content.version)
      .unsignedInteger("tx", content.transmitted)
      .decimal("rssi", frame.rssi, 1)
      .decimal("snr", frame.snr, 2)
      .decimal("ferr", frame.frequencyError, 0)
      .beginArray("neighbors");
  for (uint8_t index = 0; index < content.neighborCount; ++index) {
    const HelloNeighborEntry &entry = content.neighbors[index];
    event.beginObject()
        .nodeId("id", entry.id)
        .decimal("rssi", entry.rssi, 1)
        .decimal("snr", entry.snr, 2)
        .endObject();
  }
  event.endArray();
  console_.writeEvent(event);
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

  EventWriter event("echo");
  event.nodeId("dst", header.source)
      .unsignedInteger("n", number)
      .unsignedInteger("size", length)
      .wideInteger("rtt", roundTripMicros)
      .decimal("rssi", frame.rssi, 1)
      .decimal("snr", frame.snr, 2)
      .decimal("remote_rssi", remoteRssi, 1)
      .decimal("remote_snr", remoteSnr, 2);
  console_.writeEvent(event);
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

  EventWriter event("test_rx");
  event.nodeId("src", header.source)
      .unsignedInteger("run", fields.run)
      .unsignedInteger("index", fields.index)
      .unsignedInteger("count", fields.count)
      .unsignedInteger("size", length)
      .decimal("rssi", frame.rssi, 1)
      .decimal("snr", frame.snr, 2)
      .decimal("ferr", frame.frequencyError, 0);
  console_.writeEvent(event);

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

void NodeApplication::serviceConsole() {
  char line[CONSOLE_LINE_CAPACITY + 1];
  bool overflowed = false;
  for (int command = 0; command < MAXIMUM_COMMANDS_PER_POLL; ++command) {
    if (!console_.readCommand(line, sizeof(line), overflowed)) {
      return;
    }
    if (overflowed) {
      char *tokens[MAXIMUM_COMMAND_TOKENS];
      const size_t count = tokenize(line, tokens);
      emitError(count > 0 && count != COMMAND_TOKEN_OVERFLOW ? tokens[0] : "", "line_too_long");
      continue;
    }
    executeCommand(line);
  }
}

void NodeApplication::executeCommand(char *line) {
  char *tokens[MAXIMUM_COMMAND_TOKENS];
  const size_t count = tokenize(line, tokens);
  if (count == 0) {
    return;
  }
  if (count == COMMAND_TOKEN_OVERFLOW) {
    emitError(tokens[0], "usage", "too many arguments");
    return;
  }
  const char *command = tokens[0];
  if (strcmp(command, "help") == 0) {
    commandHelp();
  } else if (strcmp(command, "status") == 0) {
    commandStatus();
  } else if (strcmp(command, "radio") == 0) {
    commandRadio(count, tokens);
  } else if (strcmp(command, "echo") == 0) {
    commandEcho(count, tokens);
  } else if (strcmp(command, "run") == 0) {
    commandRun(count, tokens);
  } else if (strcmp(command, "wifi") == 0) {
    commandWifi(count, tokens);
  } else if (strcmp(command, "resend") == 0) {
    commandResend(count);
  } else {
    emitError(command, "unknown_command");
  }
}

void NodeApplication::commandHelp() {
  static const char *const lines[] = {
      "commands:",
      "  help",
      "  status",
      "  radio",
      "  radio <key> <value> [<key> <value> ...]",
      "    keys: freq sf bw cr preamble sync power lna",
      "  radio reset",
      "  echo <id> [size]",
      "  run <count> <size> <interval_ms>",
      "  run stop",
      "  wifi on|off",
      "  resend",
  };
  for (const char *text : lines) {
    console_.writeDebug(text);
  }
}

void NodeApplication::commandStatus() {
  EventWriter status("status");
  status.nodeId("id", identity_.nodeId())
      .text("model", board_.modelName())
      .unsignedInteger("epoch", identity_.epoch())
      .unsignedInteger("tx", transmittedCount_)
      .unsignedInteger("rx", receivedCount_)
      .unsignedInteger("dropped", console_.droppedLineCount())
      .unsignedInteger("heap", ESP.getFreeHeap());
  console_.writeEvent(status);
  emitRadio();
  emitWifi();

  const uint32_t now = millis();
  for (size_t index = 0; index < neighbors_.count(); ++index) {
    const Neighbor &neighbor = neighbors_.at(index);
    EventWriter event("neighbor");
    event.nodeId("id", neighbor.id)
        .text("model", boardModelName(neighbor.model))
        .unsignedInteger("version", neighbor.version)
        .unsignedInteger("tx", neighbor.transmitted)
        .decimal("rssi", neighbor.rssi, 1)
        .decimal("snr", neighbor.snr, 2)
        .unsignedInteger("age", now - neighbor.lastHeardMillis);
    console_.writeEvent(event);
  }
}

void NodeApplication::commandRadio(size_t argumentCount, char **arguments) {
  if (argumentCount == 1) {
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
  if (argumentCount == 2 && strcmp(arguments[1], "reset") == 0) {
    requestRadioSettings(defaultRadioSettings());
    return;
  }
  if ((argumentCount - 1) % 2 != 0) {
    emitError("radio", "usage", "radio <key> <value> ...");
    return;
  }

  RadioSettings candidate = hasPendingSettings_ ? pendingSettings_ : radio_.settings();
  char detail[ERROR_DETAIL_CAPACITY];
  for (size_t index = 1; index + 1 < argumentCount; index += 2) {
    const SettingUpdate update = updateRadioSetting(
        candidate, arguments[index], arguments[index + 1], board_, detail, sizeof(detail));
    if (update != SettingUpdate::Accepted) {
      emitError("radio", settingUpdateReason(update), detail);
      return;
    }
  }
  requestRadioSettings(candidate);
}

void NodeApplication::commandEcho(size_t argumentCount, char **arguments) {
  if (argumentCount < 2 || argumentCount > 3) {
    emitError("echo", "usage", "echo <id> [size]");
    return;
  }
  if (isRunActive() || echo_.isPending()) {
    emitError("echo", "busy");
    return;
  }
  if (!radioReady_) {
    emitError("echo", "radio_failure", "radio not started");
    return;
  }
  uint16_t destination = 0;
  if (!parseNodeId(arguments[1], destination) || destination == identity_.nodeId()) {
    emitError("echo", "usage", "echo <id> [size] with the id of another node");
    return;
  }
  unsigned long size = DEFAULT_ECHO_SIZE;
  if (argumentCount == 3) {
    const NumberParse parse =
        parseUnsigned(arguments[2], MINIMUM_ECHO_SIZE, MAXIMUM_PAYLOAD_SIZE, size);
    if (parse == NumberParse::Invalid) {
      emitError("echo", "usage", "echo <id> [size]");
      return;
    }
    if (parse == NumberParse::OutOfRange) {
      emitError("echo", "out_of_range", "size 4..239");
      return;
    }
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

void NodeApplication::commandRun(size_t argumentCount, char **arguments) {
  if (argumentCount == 2 && strcmp(arguments[1], "stop") == 0) {
    if (!runs_.isSending()) {
      emitError("run", "usage", "no run in progress");
      return;
    }
    runs_.requestStop();
    return;
  }
  if (argumentCount != 4) {
    emitError("run", "usage", "run <count> <size> <interval_ms> | run stop");
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
  const NumberParse countParse = parseUnsigned(arguments[1], 1, 65535, count);
  const NumberParse sizeParse =
      parseUnsigned(arguments[2], MINIMUM_TEST_SIZE, MAXIMUM_PAYLOAD_SIZE, size);
  const NumberParse intervalParse =
      parseUnsigned(arguments[3], 0, MAXIMUM_RUN_INTERVAL_MS, interval);
  if (countParse == NumberParse::Invalid || sizeParse == NumberParse::Invalid ||
      intervalParse == NumberParse::Invalid) {
    emitError("run", "usage", "run <count> <size> <interval_ms>");
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
  EventWriter event("run_start");
  event.unsignedInteger("run", run)
      .unsignedInteger("count", count)
      .unsignedInteger("size", size)
      .unsignedInteger("interval", interval);
  console_.writeEvent(event);
  debug("run %u start %lux%lu", run, count, size);
  updateSuspension(now);
}

void NodeApplication::commandWifi(size_t argumentCount, char **arguments) {
  if (argumentCount != 2) {
    emitError("wifi", "usage", "wifi on|off");
    return;
  }
  if (strcmp(arguments[1], "on") == 0) {
    if (!wireless_.begin(accessPointName_, J5_ACCESS_POINT_PASSWORD, ACCESS_POINT_CHANNEL,
                         ACCESS_POINT_MAXIMUM_CLIENTS)) {
      emitError("wifi", "wifi_failure", "access point did not start");
    }
  } else if (strcmp(arguments[1], "off") == 0) {
    wireless_.end();
  } else {
    emitError("wifi", "usage", "wifi on|off");
    return;
  }
  wireless_.takeClientChange();
  emitWifi();
  debug("wifi %s", wireless_.isEnabled() ? "on" : "off");
  updateStatusLine();
}

void NodeApplication::commandResend(size_t argumentCount) {
  if (argumentCount != 1) {
    emitError("resend", "usage", "resend");
    return;
  }
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
    EventWriter event("echo_lost");
    event.nodeId("dst", echo_.destination())
        .unsignedInteger("n", echo_.number())
        .unsignedInteger("size", echo_.size())
        .unsignedInteger("timeout", echo_.timeoutMillis());
    console_.writeEvent(event);
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
  const int64_t duration = run.sent > 0 ? run.lastEndMicros - run.firstStartMicros : 0;
  EventWriter event("run_done");
  event.unsignedInteger("run", run.run)
      .unsignedInteger("count", run.count)
      .unsignedInteger("sent", run.sent)
      .wideInteger("duration", duration)
      .flag("aborted", aborted);
  console_.writeEvent(event);
  debug("run %u done %u/%u", run.run, run.sent, run.count);
  runs_.finishSending();
  updateSuspension(millis());
}

void NodeApplication::finishReceiverRun(ReceiverRun &run, const char *reason) {
  EventWriter event("run_end");
  event.nodeId("src", run.source)
      .unsignedInteger("run", run.run)
      .unsignedInteger("count", run.count)
      .unsignedInteger("received", run.received)
      .decimal("pdr", static_cast<float>(run.received) / run.count, 4);
  if (run.received > 0) {
    event.decimal("rssi_avg", run.rssiSum / run.received, 1)
        .decimal("rssi_min", run.rssiMinimum, 1)
        .decimal("rssi_max", run.rssiMaximum, 1)
        .decimal("snr_avg", run.snrSum / run.received, 2);
  } else {
    event.nullValue("rssi_avg").nullValue("rssi_min").nullValue("rssi_max").nullValue("snr_avg");
  }
  event.unsignedInteger("first", run.firstMillis)
      .unsignedInteger("last", run.lastMillis)
      .text("reason", reason);
  console_.writeEvent(event);
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
  EventWriter event("boot");
  event.nodeId("id", identity_.nodeId())
      .text("model", board_.modelName())
      .unsignedInteger("epoch", identity_.epoch())
      .text("firmware", FIRMWARE_VERSION)
      .unsignedInteger("protocol", PROTOCOL_VERSION)
      .text("key", strcmp(J5_NETWORK_KEY, DEFAULT_NETWORK_KEY) == 0 ? "default" : "custom");
  console_.writeEvent(event);
}

void NodeApplication::emitRadio() {
  const RadioSettings &settings = radio_.settings();
  EventWriter event("radio");
  event.decimal("freq", settings.frequencyMhz, 3)
      .unsignedInteger("sf", settings.spreadingFactor)
      .unsignedInteger("bw", settings.bandwidthKhz)
      .unsignedInteger("cr", settings.codingRateDenominator)
      .unsignedInteger("preamble", settings.preambleLength)
      .unsignedInteger("sync", settings.syncWord)
      .integer("power", settings.transmitPowerDbm)
      .integer("chip", radio_.transceiverPower());
  if (board_.hasLowNoiseAmplifier()) {
    event.text("lna", settings.lowNoiseAmplifierEnabled ? "on" : "bypass");
  } else {
    event.nullValue("lna");
  }
  console_.writeEvent(event);
}

void NodeApplication::emitWifi() {
  EventWriter event("wifi");
  event.text("state", wireless_.isEnabled() ? "on" : "off")
      .text("ssid", accessPointName_)
      .unsignedInteger("channel", ACCESS_POINT_CHANNEL)
      .unsignedInteger("clients", wireless_.clientCount());
  console_.writeEvent(event);
}

void NodeApplication::emitError(const char *command, const char *reason, const char *detail,
                                int16_t code) {
  EventWriter event("error");
  event.text("cmd", command).text("reason", reason);
  if (detail != nullptr && detail[0] != '\0') {
    event.text("detail", detail);
  }
  if (code != 0) {
    event.integer("code", code);
  }
  console_.writeEvent(event);
  debug("error %s %s", command, reason);
}

void NodeApplication::emitDrop(const char *reason, const ReceivedFrame &frame) {
  EventWriter event("drop");
  event.text("reason", reason)
      .unsignedInteger("size", frame.length)
      .decimal("rssi", frame.rssi, 1)
      .decimal("snr", frame.snr, 2);
  console_.writeEvent(event);
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

} // namespace j5
