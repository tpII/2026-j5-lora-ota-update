#include "echo_service.h"

#include "../protocol/protocol_contract.h"

namespace firmware {

size_t EchoService::buildRequest(uint16_t destination, uint16_t size, FrameDescription &description,
                                 uint8_t *payload) {
  const EchoRequestMessage request{++requestCounter_, size};
  pending_ = true;
  transmitting_ = false;
  destination_ = destination;
  number_ = request.number;
  size_ = size;
  startMicros_ = 0;
  startMillis_ = 0;
  timeoutMillis_ = 0;
  description.type = MessageType::EchoRequest;
  description.destination = destination;
  return encodeEchoRequest(request, payload);
}

size_t EchoService::buildReply(const FrameHeader &header, const EchoRequestMessage &request,
                               const ReceivedFrame &frame, FrameDescription &description,
                               uint8_t *payload) {
  const EchoReplyMessage reply{request.number, frame.rssi, frame.snr, request.size};
  description.type = MessageType::EchoReply;
  description.destination = header.source;
  // Every reply gets an outcome from the queue, which frees its slot, so one is always free.
  description.tag = MAXIMUM_PENDING_REPLIES;
  for (uint8_t slot = 0; slot < MAXIMUM_PENDING_REPLIES; ++slot) {
    if (!replies_[slot].used) {
      replies_[slot] = PendingReply{true, reply};
      description.tag = slot;
      break;
    }
  }
  return encodeEchoReply(reply, payload);
}

void EchoService::onTransmitStarted(const FrameDescription &frame, const TransmitTiming &timing) {
  if (frame.type == MessageType::EchoReply) {
    if (frame.tag >= MAXIMUM_PENDING_REPLIES || !replies_[frame.tag].used) {
      return;
    }
    PendingReply &pending = replies_[frame.tag];
    pending.used = false;
    // The reply is already on the air, so writing the event does not delay it.
    const EchoReplyMessage &reply = pending.reply;
    JsonObject event = events_->beginEvent(ConsoleEvent::EchoServed);
    setNodeId(event, "src", frame.destination);
    event["n"] = reply.number;
    event["size"] = reply.size;
    setLinkQuality(event, reply.rssi, reply.snr);
    events_->writeEvent();
    return;
  }
  transmitting_ = true;
  startMicros_ = timing.startMicros;
  startMillis_ = timing.nowMillis;
  timeoutMillis_ = echoLossDeadlineMillis(timing.calculatedTimeOnAirMicros);
}

void EchoService::onTransmitFailed(const FrameDescription &frame) {
  if (frame.type == MessageType::EchoRequest) {
    pending_ = false;
  } else if (frame.type == MessageType::EchoReply && frame.tag < MAXIMUM_PENDING_REPLIES) {
    replies_[frame.tag].used = false;
  }
}

void EchoService::handleReply(const FrameHeader &header, const EchoReplyMessage &reply,
                              const ReceivedFrame &frame) {
  if (!pending_ || !transmitting_ || header.source != destination_ || reply.number != number_) {
    return;
  }
  const int64_t roundTripMicros = frame.receivedAtMicros - startMicros_;
  JsonObject event = events_->beginEvent(ConsoleEvent::Echo);
  setNodeId(event, "dst", header.source);
  event["n"] = reply.number;
  event["size"] = reply.size;
  event["rtt"] = roundTripMicros;
  setLinkQuality(event, frame.rssi, frame.snr);
  setRssi(event, "remote_rssi", reply.rssi);
  setSnr(event, "remote_snr", reply.snr);
  events_->writeEvent();
  pending_ = false;
  events_->debug("echo %04X %.1f ms", header.source, roundTripMicros / 1000.0);
}

void EchoService::poll(uint32_t nowMillis) {
  if (!pending_ || !transmitting_ || nowMillis - startMillis_ < timeoutMillis_) {
    return;
  }
  JsonObject event = events_->beginEvent(ConsoleEvent::EchoLost);
  setNodeId(event, "dst", destination_);
  event["n"] = number_;
  event["size"] = size_;
  event["timeout"] = timeoutMillis_;
  events_->writeEvent();
  events_->debug("echo %04X lost", destination_);
  pending_ = false;
}

} // namespace firmware
