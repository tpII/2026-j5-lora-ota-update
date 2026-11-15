#include "node_services.h"

#include "../messages/message_body.h"
#include "../radio/time_on_air.h"

namespace firmware {

bool NodeServices::begin(EventSink &events, uint16_t nodeId, BoardModel model, PinPort &pins,
                         SequenceSource &sequences, uint32_t nowMillis) {
  events_ = &events;
  nodeId_ = nodeId;
  model_ = model;
  sequences_ = &sequences;
  transmissions.begin(events);
  presence.begin(events, neighbors, transfer, nowMillis);
  echo.begin(events);
  runs.begin(events, presence);
  activation.begin(events, transfer, presence, pins, model);
  const bool operatorKeyValid = transfer.begin(events, neighbors, activation, nodeId);
  queue.setRecorder(transmissions);
  queue.setListener(FrameOwner::Echo, echo);
  queue.setListener(FrameOwner::TestRun, runs);
  queue.setListener(FrameOwner::Transfer, transfer);
  return operatorKeyValid;
}

bool NodeServices::isHelloDue(uint32_t nowMillis) const {
  if (isSuspended()) {
    return false;
  }
  return presence.isImmediateRequested() ||
         (!transfer.isBurstInProgress(nowMillis) && presence.isPeriodicHelloDue(nowMillis));
}

AnnouncedState NodeServices::announcedState() const {
  AnnouncedState announced{};
  announced.modelKnown = true;
  announced.model = model_;
  announced.lastFault = activation.lastFault();
  announced.vmFailing = activation.hasFaultedSinceReport();
  announced.version = activation.activeVersion();
  announced.available = transfer.availableVersion();
  announced.transmitted = queue.sentCount();
  return announced;
}

void NodeServices::poll(uint32_t nowMillis) {
  echo.poll(nowMillis);
  runs.poll(nowMillis);
  presence.poll(nowMillis);
  activation.poll(nowMillis);
}

// ---------------------------------------------------------------------------------------------
// Transmission

const QueuedFrame *NodeServices::nextFrame(uint32_t nowMillis, const RadioSettings &settings) {
  if (queue.isEmpty()) {
    if (runs.isFrameDue(nowMillis)) {
      enqueueTestFrame();
    } else if (isHelloDue(nowMillis)) {
      enqueueHello(nowMillis);
    } else if (!isSuspended()) {
      enqueueTransferFrame(nowMillis, settings);
    }
  }
  return queue.isEmpty() ? nullptr : &queue.next();
}

void NodeServices::recordTransmitStart(uint32_t nowMillis, int64_t startMicros,
                                       const RadioSettings &settings) {
  // The time on air by the formula serves the deadline of an echo and the tx event; the radio
  // settings do not change until the transmission ends.
  queue.startNext(TransmitTiming{nowMillis, startMicros, 0,
                                 computeTimeOnAirMicros(queue.next().length, settings)});
}

bool NodeServices::requestEcho(uint16_t destination, uint16_t size) {
  FrameDescription description{};
  uint8_t payload[MAXIMUM_PAYLOAD_SIZE];
  const size_t length = echo.buildRequest(destination, size, description, payload);
  return enqueueMessage(FrameOwner::Echo, description, payload, length, false);
}

bool NodeServices::enqueueMessage(FrameOwner owner, FrameDescription description,
                                  const uint8_t *payload, size_t payloadLength, bool priority) {
  uint8_t frame[MAXIMUM_FRAME_SIZE];
  size_t length = 0;
  if (!queue.isFull()) {
    FrameHeader header{};
    header.type = static_cast<uint8_t>(description.type);
    header.source = nodeId_;
    header.destination = description.destination;
    sequences_->assignSequence(header.epoch, header.sequence);
    description.sequence = header.sequence;
    length = encodeFrame(header, payload, payloadLength, frame);
  }
  return queue.enqueue(frame, length, owner, description, priority);
}

void NodeServices::enqueueHello(uint32_t nowMillis) {
  FrameDescription description{};
  uint8_t payload[MAXIMUM_PAYLOAD_SIZE];
  const size_t length = presence.buildHello(announcedState(), nowMillis, description, payload);
  // The failing bit covers the interval up to this HELLO; the next one starts clean.
  activation.clearFaultReport();
  enqueueMessage(FrameOwner::Presence, description, payload, length, false);
}

void NodeServices::enqueueEchoReply(const FrameHeader &header, const EchoRequestMessage &request,
                                    const ReceivedFrame &frame) {
  FrameDescription description{};
  uint8_t payload[MAXIMUM_PAYLOAD_SIZE];
  const size_t length = echo.buildReply(header, request, frame, description, payload);
  enqueueMessage(FrameOwner::Echo, description, payload, length, true);
}

void NodeServices::enqueueTestFrame() {
  FrameDescription description{};
  uint8_t payload[MAXIMUM_PAYLOAD_SIZE];
  const size_t length = runs.buildNextFrame(description, payload);
  enqueueMessage(FrameOwner::TestRun, description, payload, length, false);
}

void NodeServices::enqueueTransferFrame(uint32_t nowMillis, const RadioSettings &settings) {
  // Every fragment goes in a new frame with a new sequence.
  FrameDescription description{};
  uint8_t payload[MAXIMUM_PAYLOAD_SIZE];
  const size_t length = transfer.buildNextFrame(nowMillis, settings, description, payload);
  if (length == 0) {
    return;
  }
  enqueueMessage(FrameOwner::Transfer, description, payload, length, false);
}

// ---------------------------------------------------------------------------------------------
// Reception

void NodeServices::receive(const ReceivedFrame &frame, uint32_t nowMillis,
                           const RadioSettings &settings) {
  if (!frame.integrityVerified) {
    writeDropEvent(*events_, DropReason::Crc, frame);
    return;
  }
  FrameHeader header{};
  const uint8_t *payload = nullptr;
  size_t payloadLength = 0;
  switch (decodeFrame(frame.data, frame.length, header, payload, payloadLength)) {
  case FrameCheck::TooShort:
    writeDropEvent(*events_, DropReason::Short, frame);
    return;
  case FrameCheck::InvalidTag:
    writeDropEvent(*events_, DropReason::Tag, frame);
    return;
  case FrameCheck::Valid:
    break;
  }
  MessageBody body{};
  switch (decodeMessageBody(header.type, payload, payloadLength, body)) {
  case BodyCheck::UnknownType:
    writeDropEvent(*events_, DropReason::Type, frame);
    return;
  case BodyCheck::Invalid:
    writeDropEvent(*events_, DropReason::Body, frame);
    return;
  case BodyCheck::Valid:
    break;
  }
  if (header.source == nodeId_) {
    writeIdConflictEvent(*events_, header, frame);
    return;
  }
  if (!duplicates_.acceptIfNew(header.source, header.epoch, header.sequence, nowMillis)) {
    writeDuplicateEvent(*events_, header, body.type);
    return;
  }

  // Every node that this one hears is a neighbor, whoever the frame is for.
  ++receivedCount_;
  neighbors.recordFrame(header.source, frame.rssi, frame.snr, nowMillis);
  if (header.destination != BROADCAST_NODE_ID && header.destination != nodeId_) {
    return;
  }

  switch (body.type) {
  case MessageType::Hello:
    presence.handleHello(header, body.hello, frame, nowMillis);
    break;
  case MessageType::EchoRequest:
    enqueueEchoReply(header, body.echoRequest, frame);
    break;
  case MessageType::EchoReply:
    echo.handleReply(header, body.echoReply, frame);
    break;
  case MessageType::Test:
    runs.handleTestFrame(header, body.test, frame, settings, nowMillis);
    break;
  case MessageType::Fragment:
    transfer.handleFragment(header.source, body.fragment, frame.rssi, frame.snr, settings,
                            nowMillis);
    break;
  case MessageType::Report:
    transfer.handleReport(header, body.report);
    break;
  }
}

} // namespace firmware
