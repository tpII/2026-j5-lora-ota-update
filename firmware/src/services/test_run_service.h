#ifndef J5_TEST_RUN_SERVICE_H
#define J5_TEST_RUN_SERVICE_H

#include <stddef.h>
#include <stdint.h>

#include "../configuration.h"

namespace firmware {

// Fields at the start of a TEST body (docs/protocol/frame.md).
struct TestFields {
  uint16_t run;
  uint16_t index;
  uint16_t count;
  uint16_t interval;
};

constexpr size_t TEST_FIELDS_SIZE = 8;

struct SenderRun {
  bool active;
  bool stopRequested;
  bool frameInFlight;
  uint16_t run;
  uint16_t count;
  uint16_t size;
  uint16_t interval;
  uint16_t nextIndex;
  uint16_t sent;
  int64_t firstStartMicros;
  int64_t lastEndMicros;
  uint32_t nextTransmitMillis;
};

struct ReceiverRun {
  bool active;
  uint16_t source;
  uint16_t run;
  uint16_t count;
  uint16_t interval;
  uint16_t received;
  float rssiSum;
  float rssiMinimum;
  float rssiMaximum;
  float snrSum;
  uint32_t firstMillis;
  uint32_t lastMillis;
  uint32_t deadlineMillis;
};

// Test runs: the sender transmits numbered TEST frames, one at a time; receivers keep the
// statistics of each run they hear. The service only keeps state; the application performs the
// transmissions and emits the events.
class TestRunService {
public:
  // Sender side.
  bool isSending() const { return sender_.active; }
  const SenderRun &sender() const { return sender_; }
  uint16_t startSending(uint16_t count, uint16_t size, uint16_t interval, uint32_t nowMillis);
  void requestStop() { sender_.stopRequested = true; }
  bool isFrameDue(uint32_t nowMillis) const;
  // Writes the body of the next frame and reserves it as the frame in flight.
  size_t buildNextPayload(uint8_t *output);
  void onFrameStarted(int64_t startMicros);
  // Returns true when the run has finished: every frame sent or a stop requested.
  bool onFrameSent(int64_t endMicros, uint32_t nowMillis);
  void onFrameFailed();
  void finishSending() { sender_.active = false; }

  // Receiver side.
  bool isReceiving() const;
  ReceiverRun *findActiveRun(uint16_t source);
  // Updates the statistics of the run, opening it on its first frame. Sets completed when the
  // last frame of the run arrived. Returns nullptr when no slot is free.
  ReceiverRun *recordTestFrame(uint16_t source, const TestFields &fields, float rssi, float snr,
                               uint32_t nowMillis, uint32_t timeOnAirMillis, bool &opened,
                               bool &completed);
  ReceiverRun *findExpiredRun(uint32_t nowMillis);
  void closeRun(ReceiverRun &run) { run.active = false; }

  static size_t encodePayload(const TestFields &fields, uint16_t size, uint8_t *output);
  static bool decodePayload(const uint8_t *payload, size_t length, TestFields &fields);

private:
  SenderRun sender_ = {};
  uint16_t nextRunNumber_ = 1;
  ReceiverRun receivers_[MAXIMUM_RECEIVER_RUNS] = {};
};

} // namespace firmware

#endif
