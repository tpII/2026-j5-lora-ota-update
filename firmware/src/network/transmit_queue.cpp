#include "transmit_queue.h"

#include <string.h>

namespace firmware {

void TransmitQueue::setListener(FrameOwner owner, TransmitListener &listener) {
  listeners_[static_cast<size_t>(owner)] = &listener;
}

TransmitListener *TransmitQueue::listenerOf(FrameOwner owner) const {
  return owner == FrameOwner::Resend ? nullptr : listeners_[static_cast<size_t>(owner)];
}

bool TransmitQueue::enqueue(const uint8_t *data, size_t length, FrameOwner owner,
                            const FrameDescription &description, bool priority) {
  if (isFull() || length < FRAME_OVERHEAD || length > MAXIMUM_FRAME_SIZE) {
    if (TransmitListener *listener = listenerOf(owner)) {
      listener->onTransmitFailed(description);
    }
    return false;
  }
  QueuedFrame &slot =
      slots_[priority ? (head_ + TRANSMIT_QUEUE_CAPACITY - 1) % TRANSMIT_QUEUE_CAPACITY
                      : (head_ + count_) % TRANSMIT_QUEUE_CAPACITY];
  memcpy(slot.data, data, length);
  slot.length = length;
  slot.owner = owner;
  slot.description = description;
  if (priority) {
    head_ = (head_ + TRANSMIT_QUEUE_CAPACITY - 1) % TRANSMIT_QUEUE_CAPACITY;
  }
  ++count_;
  return true;
}

bool TransmitQueue::enqueueResend() {
  if (!hasLastSent_ || isFull()) {
    return false;
  }
  QueuedFrame &slot = slots_[(head_ + count_) % TRANSMIT_QUEUE_CAPACITY];
  slot = lastSent_;
  slot.owner = FrameOwner::Resend;
  ++count_;
  return true;
}

void TransmitQueue::startNext(const TransmitTiming &start) {
  inFlight_ = slots_[head_];
  inFlightTiming_ = start;
  head_ = (head_ + 1) % TRANSMIT_QUEUE_CAPACITY;
  --count_;
  if (TransmitListener *listener = listenerOf(inFlight_.owner)) {
    listener->onTransmitStarted(inFlight_.description, inFlightTiming_);
  }
}

void TransmitQueue::failNext() {
  const FrameOwner owner = slots_[head_].owner;
  const FrameDescription description = slots_[head_].description;
  head_ = (head_ + 1) % TRANSMIT_QUEUE_CAPACITY;
  --count_;
  if (TransmitListener *listener = listenerOf(owner)) {
    listener->onTransmitFailed(description);
  }
}

void TransmitQueue::completeInFlight(int64_t endMicros, uint32_t nowMillis) {
  inFlightTiming_.endMicros = endMicros;
  inFlightTiming_.nowMillis = nowMillis;
  ++sentCount_;
  lastSent_ = inFlight_;
  hasLastSent_ = true;
  if (recorder_ != nullptr) {
    recorder_->recordTransmission(inFlight_, inFlightTiming_);
  }
  if (TransmitListener *listener = listenerOf(inFlight_.owner)) {
    listener->onTransmitDone(inFlight_.description, inFlightTiming_);
  }
}

} // namespace firmware
