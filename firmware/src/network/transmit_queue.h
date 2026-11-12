#ifndef J5_TRANSMIT_QUEUE_H
#define J5_TRANSMIT_QUEUE_H

#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

// Frames that wait for the transmitter, besides the one on the air.
constexpr size_t TRANSMIT_QUEUE_CAPACITY = 4;

// Who built a frame, and so who hears how its transmission ends. A frame that resend queues again
// belongs to Resend, which nobody hears: it never reaches the service that built the original.
enum class FrameOwner : uint8_t {
  Presence,
  Echo,
  TestRun,
  Transfer,
  Resend, // the last one
};
constexpr size_t FRAME_OWNER_COUNT = static_cast<size_t>(FrameOwner::Resend) + 1;

// What the queue keeps about a frame besides its bytes: the fields that the tx event reports and a
// tag with which the owner of the frame recognizes it when its transmission ends.
struct FrameDescription {
  MessageType type;
  uint16_t destination;
  uint16_t sequence;
  uint16_t run;     // TEST: the run
  uint16_t index;   // TEST: position in the run; FRAGMENT: index in the image
  uint32_t version; // FRAGMENT and REPORT: version of the image
  uint8_t tag;      // chosen by the owner; no event reports it
};

struct QueuedFrame {
  uint8_t data[MAXIMUM_FRAME_SIZE];
  size_t length;
  FrameOwner owner;
  FrameDescription description;
};

struct TransmitTiming {
  uint32_t nowMillis; // reading of millis() of the pass that reports the start or the end
  int64_t startMicros;
  int64_t endMicros; // once the transmission ended
  uint32_t calculatedTimeOnAirMicros;
};

// Hears how the transmissions of the frames of one owner end. Every frame offered to the queue
// gets one outcome: onTransmitFailed, at once when the queue refuses it or later when the radio
// does, or onTransmitStarted followed by onTransmitDone.
class TransmitListener {
public:
  virtual void onTransmitStarted(const FrameDescription &, const TransmitTiming &) {}
  virtual void onTransmitDone(const FrameDescription &, const TransmitTiming &) {}
  virtual void onTransmitFailed(const FrameDescription &) {}

protected:
  ~TransmitListener() = default;
};

// Hears every transmission that ends, whoever owns the frame, before its owner does.
class TransmissionRecorder {
public:
  virtual void recordTransmission(const QueuedFrame &frame, const TransmitTiming &timing) = 0;

protected:
  ~TransmissionRecorder() = default;
};

// The frames that wait for the radio, the one on the air and the last one sent, each with its
// owner. The node takes the frames out one at a time and tells the queue how each transmission
// went; the queue keeps the times of the frame on the air and passes the outcome on to the
// recorder and to the owner of the frame.
class TransmitQueue {
public:
  void setListener(FrameOwner owner, TransmitListener &listener);
  void setRecorder(TransmissionRecorder &recorder) { recorder_ = &recorder; }

  bool isEmpty() const { return count_ == 0; }
  bool isFull() const { return count_ >= TRANSMIT_QUEUE_CAPACITY; }

  // Queues an encoded frame behind the others or, with priority, before them. Returns false and
  // tells the owner that the frame failed when the queue is full or the length is not that of a
  // frame, such as the 0 that encodeFrame returns for a body too long.
  bool enqueue(const uint8_t *data, size_t length, FrameOwner owner,
               const FrameDescription &description, bool priority);
  bool hasLastSent() const { return hasLastSent_; }
  // Queues again, byte for byte and behind the others, the last frame sent, owned by Resend.
  bool enqueueResend();

  // The frame that goes out next, while the queue is not empty.
  const QueuedFrame &next() const { return slots_[head_]; }
  // The radio started next() at start.startMicros: it leaves the queue as the frame in flight.
  void startNext(const TransmitTiming &start);
  // The radio refused next(): it leaves the queue and fails.
  void failNext();
  // The transmission of the frame in flight ended at endMicros, as the pass at nowMillis saw: it
  // becomes the last frame sent.
  void completeInFlight(int64_t endMicros, uint32_t nowMillis);
  // Frames sent since the boot, those of resend included.
  uint32_t sentCount() const { return sentCount_; }

private:
  TransmitListener *listenerOf(FrameOwner owner) const;

  TransmitListener *listeners_[FRAME_OWNER_COUNT] = {};
  TransmissionRecorder *recorder_ = nullptr;
  QueuedFrame slots_[TRANSMIT_QUEUE_CAPACITY] = {};
  size_t head_ = 0;
  size_t count_ = 0;
  QueuedFrame inFlight_ = {};
  TransmitTiming inFlightTiming_ = {};
  QueuedFrame lastSent_ = {};
  bool hasLastSent_ = false;
  uint32_t sentCount_ = 0;
};

} // namespace firmware

#endif
