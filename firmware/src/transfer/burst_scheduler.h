#ifndef J5_BURST_SCHEDULER_H
#define J5_BURST_SCHEDULER_H

#include <stddef.h>
#include <stdint.h>

#include "../messages/fragment_message.h"
#include "../messages/report_message.h"
#include "../protocol/protocol_contract.h"
#include "../timing/transmission_span.h"

namespace firmware {

// Bursts that wait behind the one in progress, that one included.
constexpr size_t BURST_QUEUE_CAPACITY = 4;

// A burst as the burst_start and burst_done events describe it.
struct BurstSummary {
  BurstCause cause;
  uint16_t trigger; // node whose HELLO or report caused the burst; NO_NODE_ID for the others
  uint32_t version;
  uint8_t size;
  uint8_t initialCount; // fragments pending when the first one was taken
  uint16_t sent;
  int64_t durationMicros; // from the start of the first fragment to the end of the last one
};

// The bursts of the available image (docs/adrs/0010-receiver-driven-repair.md): the one in
// progress, first, and those waiting behind it. Fragments are taken one at a time, when the
// transmitter asks for the next one, in index order. A report adds its fragments to a burst of the
// same size, in progress or waiting; the scheduler keeps no state per receiver.
class BurstScheduler {
public:
  // Carries a new image and drops every burst of the previous one. Returns true when that ends a
  // burst in progress, which ended then describes.
  bool setImage(const uint8_t *image, size_t length, uint32_t version, BurstSummary &ended);

  // Queues a burst with every fragment of the image. Returns false when the queue is full.
  bool requestFullBurst(uint8_t size, BurstCause cause, uint16_t trigger);
  bool hasBurst() const { return burstCount_ > 0; }

  // Adds the reported fragments to a burst of the same size or queues a new burst. Returns false
  // when the report is ignored: another version, a count that does not match the image, no
  // fragment marked or a full queue.
  bool mergeReport(const ReportMessage &report, uint16_t source);

  bool isFragmentDue() const { return burstCount_ > 0 && !fragmentInFlight_; }
  // Takes the next fragment of the burst in progress and reserves it as the fragment in flight;
  // its data points into the image. Returns false when none is due. On the first fragment of a
  // burst, sets burstStarted and describes the burst in burst.
  bool takeNextFragment(FragmentMessage &fragment, bool &burstStarted, BurstSummary &burst);
  void onFragmentStarted(int64_t startMicros);
  // Both return true when the burst in progress ends with the fragment in flight, which ended
  // then describes; the next burst follows. A fragment of a replaced image only frees the
  // transmitter, and a failed one is not sent again: a report asks for it if a receiver misses it.
  bool onFragmentSent(int64_t endMicros, BurstSummary &ended);
  bool onFragmentFailed(BurstSummary &ended);

private:
  static_assert(MAXIMUM_FRAGMENT_COUNT <= 64,
                "BurstScheduler keeps the pending fragments in 64 bits: MAXIMUM_FRAGMENT_COUNT, "
                "which grows with PROGRAM_CAPACITY, must not exceed 64");

  struct Burst {
    BurstCause cause;
    uint16_t trigger;
    uint8_t size;
    uint8_t count;    // fragments of the image with this size
    uint64_t pending; // bit i: fragment i still to be sent
    bool started;
    uint8_t initialCount;
    TransmissionSpan span;
  };

  // The fragment in flight belongs to the burst in progress, not to a replaced image.
  bool isFragmentOfCurrentBurst() const;
  BurstSummary summarize(const Burst &burst) const;
  void finishBurst(BurstSummary &ended);

  Burst bursts_[BURST_QUEUE_CAPACITY] = {};
  size_t burstCount_ = 0;
  const uint8_t *image_ = nullptr;
  size_t imageLength_ = 0;
  uint32_t version_ = 0;
  bool fragmentInFlight_ = false;
  uint32_t fragmentVersion_ = 0;
};

} // namespace firmware

#endif
