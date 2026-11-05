#ifndef J5_BURST_SCHEDULER_H
#define J5_BURST_SCHEDULER_H

#include <stddef.h>
#include <stdint.h>

#include "../configuration.h"
#include "transfer_messages.h"

namespace firmware {

enum class BurstCause : uint8_t { Load, Complete, Hello, Report };

// Name of the cause in the burst_start event ("load", "complete", "hello" or "report").
const char *burstCauseName(BurstCause cause);

struct Burst {
  BurstCause cause;
  uint16_t trigger; // node whose HELLO or report caused the burst; 0 for the others
  uint8_t size;
  uint8_t count;    // fragments of the image with this size
  uint64_t pending; // bit i: fragment i still to be sent
  bool started;
  uint8_t initialCount; // fragments pending when the first one was built
  uint16_t sent;
  bool timed;
  int64_t firstStartMicros;
  int64_t lastEndMicros;
};

// The bursts of the available image (docs/adrs/0010-receiver-driven-repair.md): the one in
// progress, first, and those waiting behind it. Fragments are built one at a time, when the
// transmitter asks for the next one, in index order. A report adds its fragments to a burst of the
// same size, in progress or waiting; the scheduler keeps no state per receiver.
class BurstScheduler {
public:
  // Carries a new image and drops every burst of the previous one.
  void setImage(const uint8_t *image, size_t length, uint32_t version);
  uint32_t version() const { return version_; }

  // Queues a burst with every fragment of the image. Returns false when the queue is full.
  bool requestFullBurst(uint8_t size, BurstCause cause, uint16_t trigger);
  bool hasBurst() const { return burstCount_ > 0; }
  bool hasStartedBurst() const { return burstCount_ > 0 && bursts_[0].started; }
  const Burst &currentBurst() const { return bursts_[0]; }

  // Adds the reported fragments to a burst of the same size or queues a new burst. Returns false
  // when the report is ignored: another version, a count that does not match the image, no
  // fragment marked or a full queue.
  bool mergeReport(const ReportFields &report, uint16_t source);

  bool isFragmentDue() const { return burstCount_ > 0 && !fragmentInFlight_; }
  // Writes the body of the next fragment of the current burst and reserves it as the fragment in
  // flight. burstStarted is set on the first fragment of a burst.
  size_t buildNextFragment(uint8_t *output, bool &burstStarted);
  void onFragmentStarted(int64_t startMicros);
  // Both return true when the current burst has no fragment left; the caller reads it with
  // currentBurst() and then calls finishBurst(). A fragment of a replaced image only frees the
  // transmitter.
  bool onFragmentSent(uint32_t version, int64_t endMicros);
  bool onFragmentFailed(uint32_t version);
  void finishBurst();

private:
  Burst bursts_[BURST_QUEUE_CAPACITY] = {};
  size_t burstCount_ = 0;
  const uint8_t *image_ = nullptr;
  size_t imageLength_ = 0;
  uint32_t version_ = 0;
  bool fragmentInFlight_ = false;
};

} // namespace firmware

#endif
