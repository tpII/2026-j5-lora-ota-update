// Host tests of the transmission queue: the order of the frames, the outcome that each owner hears,
// the times of the frame on the air and resend, whose frames reach no owner.

#include <cstring>
#include <string>
#include <vector>

#include "host_test_harness.h"
#include "network/transmit_queue.h"

using namespace firmware;

namespace {
struct OutcomeCounter : TransmitListener {
  void onTransmitStarted(const FrameDescription &frame, const TransmitTiming &) override {
    ++started;
    lastType = frame.type;
  }
  void onTransmitDone(const FrameDescription &frame, const TransmitTiming &) override {
    ++done;
    lastType = frame.type;
  }
  void onTransmitFailed(const FrameDescription &frame) override {
    ++failed;
    lastType = frame.type;
  }
  int outcomes() const { return started + done + failed; }

  int started = 0;
  int done = 0;
  int failed = 0;
  MessageType lastType = MessageType::Hello;
};

// Records, in one list, the transmissions that the recorder hears and those that an owner hears.
struct TransmissionLog : TransmissionRecorder, TransmitListener {
  void recordTransmission(const QueuedFrame &frame, const TransmitTiming &timing) override {
    entries.push_back("recorded " + std::to_string(frame.length) + " " + timingText(timing));
  }
  void onTransmitDone(const FrameDescription &, const TransmitTiming &timing) override {
    entries.push_back("done " + timingText(timing));
  }
  static std::string timingText(const TransmitTiming &timing) {
    return std::to_string(timing.nowMillis) + " " + std::to_string(timing.startMicros) + " " +
           std::to_string(timing.endMicros) + " " +
           std::to_string(timing.calculatedTimeOnAirMicros);
  }

  std::vector<std::string> entries;
};
} // namespace

static void fillFrame(uint8_t *frame, size_t length, uint8_t marker) {
  std::memset(frame, marker, length);
}

static FrameDescription describe(MessageType type, uint16_t sequence) {
  FrameDescription description{};
  description.type = type;
  description.destination = BROADCAST_NODE_ID;
  description.sequence = sequence;
  return description;
}

static const TransmitTiming TIMING = {1000, 5000, 6000, 900};

// Starts and completes the next frame; returns its first byte.
static uint8_t transmitNext(TransmitQueue &queue) {
  const uint8_t marker = queue.next().data[0];
  queue.startNext(TIMING);
  queue.completeInFlight(TIMING.endMicros, TIMING.nowMillis);
  return marker;
}

J5_HOST_TEST(testTransmitQueueOrder) {
  TransmitQueue queue;
  uint8_t frame[MAXIMUM_FRAME_SIZE];
  CHECK(queue.isEmpty() && !queue.hasLastSent());
  fillFrame(frame, FRAME_OVERHEAD, 1);
  CHECK(queue.enqueue(frame, FRAME_OVERHEAD, FrameOwner::Presence, describe(MessageType::Hello, 1),
                      false));
  fillFrame(frame, FRAME_OVERHEAD, 2);
  CHECK(queue.enqueue(frame, FRAME_OVERHEAD, FrameOwner::Transfer,
                      describe(MessageType::Fragment, 2), false));
  // A priority frame goes before the others, the last priority one first.
  fillFrame(frame, FRAME_OVERHEAD, 3);
  CHECK(queue.enqueue(frame, FRAME_OVERHEAD, FrameOwner::Echo, describe(MessageType::EchoReply, 3),
                      true));
  fillFrame(frame, FRAME_OVERHEAD, 4);
  CHECK(queue.enqueue(frame, FRAME_OVERHEAD, FrameOwner::Echo, describe(MessageType::EchoReply, 4),
                      true));
  CHECK(queue.isFull());
  CHECK(transmitNext(queue) == 4 && transmitNext(queue) == 3);
  CHECK(transmitNext(queue) == 1 && transmitNext(queue) == 2);
  CHECK(queue.isEmpty() && queue.sentCount() == 4);
}

J5_HOST_TEST(testTransmitQueueOutcomes) {
  TransmitQueue queue;
  OutcomeCounter runs;
  OutcomeCounter echoes;
  queue.setListener(FrameOwner::TestRun, runs);
  queue.setListener(FrameOwner::Echo, echoes);
  uint8_t frame[MAXIMUM_FRAME_SIZE] = {};

  // Started, then done: the owner hears both, and only its own frames.
  CHECK(queue.enqueue(frame, FRAME_OVERHEAD + 8, FrameOwner::TestRun,
                      describe(MessageType::Test, 1), false));
  queue.startNext(TIMING);
  CHECK(runs.started == 1 && runs.done == 0 && runs.lastType == MessageType::Test);
  queue.completeInFlight(TIMING.endMicros, TIMING.nowMillis);
  CHECK(runs.done == 1 && echoes.outcomes() == 0 && queue.sentCount() == 1);

  // Refused by the radio: it fails and is not counted as sent.
  CHECK(queue.enqueue(frame, FRAME_OVERHEAD + 4, FrameOwner::Echo,
                      describe(MessageType::EchoRequest, 2), false));
  queue.failNext();
  CHECK(echoes.failed == 1 && echoes.started == 0 && queue.isEmpty());
  CHECK(queue.sentCount() == 1);

  // Refused by the queue: a full queue, an empty frame (encodeFrame refused the body) or one too
  // long. The owner hears that the frame failed.
  CHECK(!queue.enqueue(frame, 0, FrameOwner::Echo, describe(MessageType::EchoRequest, 3), false));
  CHECK(!queue.enqueue(frame, MAXIMUM_FRAME_SIZE + 1, FrameOwner::Echo,
                       describe(MessageType::EchoRequest, 4), false));
  CHECK(echoes.failed == 3 && queue.isEmpty());
  for (size_t index = 0; index < TRANSMIT_QUEUE_CAPACITY; ++index) {
    CHECK(queue.enqueue(frame, FRAME_OVERHEAD, FrameOwner::Presence,
                        describe(MessageType::Hello, 5), false));
  }
  CHECK(!queue.enqueue(frame, FRAME_OVERHEAD + 8, FrameOwner::TestRun,
                       describe(MessageType::Test, 6), false));
  CHECK(runs.failed == 1 && runs.started == 1);
}

J5_HOST_TEST(testTransmitQueueResend) {
  TransmitQueue queue;
  OutcomeCounter owners[FRAME_OWNER_COUNT];
  for (size_t owner = 0; owner < FRAME_OWNER_COUNT; ++owner) {
    queue.setListener(static_cast<FrameOwner>(owner), owners[owner]);
  }
  uint8_t frame[MAXIMUM_FRAME_SIZE];
  fillFrame(frame, FRAME_OVERHEAD + 8, 0x5A);
  CHECK(!queue.enqueueResend());

  FrameDescription description = describe(MessageType::Test, 77);
  description.run = 3;
  description.index = 9;
  CHECK(queue.enqueue(frame, FRAME_OVERHEAD + 8, FrameOwner::TestRun, description, false));
  transmitNext(queue);
  CHECK(owners[static_cast<size_t>(FrameOwner::TestRun)].done == 1);

  // The same bytes and description go out again, but no owner hears of them, even when the
  // original belonged to a service.
  CHECK(queue.enqueueResend());
  const QueuedFrame &resent = queue.next();
  CHECK(resent.owner == FrameOwner::Resend && resent.length == FRAME_OVERHEAD + 8);
  CHECK(std::memcmp(resent.data, frame, FRAME_OVERHEAD + 8) == 0);
  CHECK(resent.description.type == MessageType::Test && resent.description.sequence == 77);
  CHECK(resent.description.run == 3 && resent.description.index == 9);
  queue.startNext(TIMING);
  queue.completeInFlight(TIMING.endMicros, TIMING.nowMillis);
  int outcomes = 0;
  for (const OutcomeCounter &owner : owners) {
    outcomes += owner.outcomes();
  }
  CHECK(outcomes == 2 && queue.sentCount() == 2);

  // A resent frame that the radio refuses reaches nobody either, and resending it again repeats
  // the same frame.
  CHECK(queue.enqueueResend());
  queue.failNext();
  CHECK(queue.enqueueResend() && queue.next().data[0] == 0x5A);
  transmitNext(queue);
  outcomes = 0;
  for (const OutcomeCounter &owner : owners) {
    outcomes += owner.outcomes();
  }
  CHECK(outcomes == 2 && queue.sentCount() == 3);
}

J5_HOST_TEST(testTransmitQueueTiming) {
  TransmitQueue queue;
  TransmissionLog log;
  queue.setRecorder(log);
  queue.setListener(FrameOwner::TestRun, log);
  uint8_t frame[MAXIMUM_FRAME_SIZE] = {};

  // The queue keeps the start of the frame on the air until its end arrives, a pass later, and
  // the recorder hears the whole timing before the owner does, resent frames included.
  CHECK(queue.enqueue(frame, FRAME_OVERHEAD + 8, FrameOwner::TestRun,
                      describe(MessageType::Test, 1), false));
  queue.startNext(TransmitTiming{1000, 5000, 0, 900});
  queue.completeInFlight(6040, 1002);
  CHECK(queue.enqueueResend());
  queue.startNext(TransmitTiming{1003, 7000, 0, 900});
  queue.completeInFlight(8000, 1004);
  const std::string length = std::to_string(FRAME_OVERHEAD + 8);
  const std::vector<std::string> expected = {
      "recorded " + length + " 1002 5000 6040 900",
      "done 1002 5000 6040 900",
      "recorded " + length + " 1004 7000 8000 900",
  };
  CHECK(log.entries == expected);
}
