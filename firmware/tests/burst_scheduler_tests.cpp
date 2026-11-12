// Host tests of the burst scheduler.

#include "host_test_harness.h"
#include "messages/fragment_message.h"
#include "messages/report_message.h"
#include "transfer/burst_scheduler.h"

using namespace firmware;

// Sends the next fragment of the scheduler and returns its index, or -1 when none is due. finished
// tells whether the burst ended with it, and ended then describes the burst.
static int sendNextFragment(BurstScheduler &bursts, bool &started, uint8_t &remaining,
                            bool &finished, BurstSummary &ended) {
  FragmentMessage fragment{};
  BurstSummary burst{};
  if (!bursts.takeNextFragment(fragment, started, burst)) {
    return -1;
  }
  remaining = fragment.remaining;
  bursts.onFragmentStarted(2000);
  finished = bursts.onFragmentSent(2100, ended);
  return fragment.index;
}

J5_HOST_TEST(testBurstScheduler) {
  uint8_t image[MAXIMUM_IMAGE_SIZE];
  for (size_t index = 0; index < sizeof(image); ++index) {
    image[index] = static_cast<uint8_t>(index * 7);
  }
  const size_t imageLength = 102;
  BurstScheduler bursts;
  BurstSummary ended{};
  CHECK(!bursts.setImage(image, imageLength, 7, ended));
  CHECK(!bursts.hasBurst() && !bursts.isFragmentDue());

  // A full burst: 4 fragments of 32 bytes in index order, with the fragments left.
  CHECK(bursts.requestFullBurst(32, BurstCause::Load, NO_NODE_ID));
  bool started = false;
  bool finished = false;
  uint8_t remaining = 0;
  FragmentMessage fragment{};
  BurstSummary burst{};
  CHECK(bursts.takeNextFragment(fragment, started, burst));
  CHECK(started && burst.cause == BurstCause::Load && burst.trigger == NO_NODE_ID);
  CHECK(burst.version == 7 && burst.size == 32 && burst.initialCount == 4 && burst.sent == 0);
  CHECK(fragment.version == 7 && fragment.index == 0 && fragment.count == 4);
  CHECK(fragment.size == 32 && fragment.remaining == 3 && fragment.dataLength == 32);
  CHECK(fragment.data == image && !bursts.isFragmentDue());
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  CHECK(encodeFragment(fragment, body) == FRAGMENT_HEADER_SIZE + 32);
  bursts.onFragmentStarted(1000);
  CHECK(!bursts.onFragmentSent(1500, ended));
  CHECK(sendNextFragment(bursts, started, remaining, finished, ended) == 1 && !started &&
        !finished);

  // A report of the same size adds its fragments to the burst in progress.
  ReportMessage report{};
  report.version = 7;
  report.size = 32;
  report.count = 4;
  markFragment(report, 0);
  CHECK(bursts.mergeReport(report, 0x00F4));
  CHECK(sendNextFragment(bursts, started, remaining, finished, ended) == 0 && remaining == 2);
  CHECK(sendNextFragment(bursts, started, remaining, finished, ended) == 2 && remaining == 1);
  // A report of another size waits as a burst of its own.
  ReportMessage other{};
  other.version = 7;
  other.size = 64;
  other.count = 2;
  markFragment(other, 1);
  CHECK(bursts.mergeReport(other, 0x00F4));
  CHECK(sendNextFragment(bursts, started, remaining, finished, ended) == 3 && remaining == 0);
  // The burst ends by itself and describes what it sent: five fragments, from the start of the
  // first one to the end of the last one.
  CHECK(finished && ended.cause == BurstCause::Load && ended.version == 7 && ended.size == 32);
  CHECK(ended.initialCount == 4 && ended.sent == 5 && ended.durationMicros == 1100);
  CHECK(bursts.hasBurst());
  CHECK(sendNextFragment(bursts, started, remaining, finished, ended) == 1 && started && finished);
  CHECK(ended.cause == BurstCause::Report && ended.trigger == 0x00F4 && ended.size == 64);
  CHECK(ended.initialCount == 1 && ended.sent == 1 && ended.durationMicros == 100);
  CHECK(!bursts.hasBurst());

  // Ignored reports: another version, a count that does not match, nothing marked.
  report.version = 6;
  CHECK(!bursts.mergeReport(report, 0x00F4));
  report.version = 7;
  report.count = 5;
  CHECK(!bursts.mergeReport(report, 0x00F4));
  ReportMessage empty{};
  empty.version = 7;
  empty.size = 32;
  empty.count = 4;
  CHECK(!bursts.mergeReport(empty, 0x00F4));
  CHECK(!bursts.hasBurst());

  // A report with no burst in progress starts one.
  report.count = 4;
  CHECK(bursts.mergeReport(report, 0x1234));
  CHECK(bursts.takeNextFragment(fragment, started, burst) && started);
  CHECK(burst.cause == BurstCause::Report && burst.trigger == 0x1234 && burst.initialCount == 1);

  // A new image ends the burst in progress and drops the others; the fragment on the air only
  // frees the transmitter.
  CHECK(bursts.setImage(image, 300, 8, ended));
  CHECK(ended.version == 7 && ended.cause == BurstCause::Report && ended.sent == 0);
  CHECK(!bursts.hasBurst());
  CHECK(bursts.requestFullBurst(231, BurstCause::Complete, NO_NODE_ID));
  CHECK(!bursts.isFragmentDue());
  bursts.onFragmentStarted(200);
  CHECK(!bursts.onFragmentSent(300, ended));
  CHECK(bursts.isFragmentDue());
  CHECK(bursts.takeNextFragment(fragment, started, burst) && fragment.dataLength == 231);
  CHECK(burst.version == 8 && burst.initialCount == 2);
  // A failed fragment is not sent again, and a burst can end without sending anything.
  CHECK(!bursts.onFragmentFailed(ended));
  CHECK(bursts.takeNextFragment(fragment, started, burst));
  CHECK(fragment.dataLength == 69 && fragment.index == 1);
  CHECK(bursts.onFragmentFailed(ended) && ended.version == 8 && ended.sent == 0);
  CHECK(ended.durationMicros == 0 && !bursts.hasBurst());
  CHECK(!bursts.setImage(image, imageLength, 9, ended));

  // The queue holds BURST_QUEUE_CAPACITY bursts.
  for (size_t index = 0; index < BURST_QUEUE_CAPACITY; ++index) {
    CHECK(bursts.requestFullBurst(32, BurstCause::Hello, 0x1234));
  }
  CHECK(!bursts.requestFullBurst(32, BurstCause::Hello, 0x1234));
}
