#include "burst_scheduler.h"

namespace firmware {

static uint8_t countPending(uint64_t pending) {
  return static_cast<uint8_t>(__builtin_popcountll(pending));
}

static uint8_t lowestPendingIndex(uint64_t pending) {
  return static_cast<uint8_t>(__builtin_ctzll(pending));
}

// Every fragment of a count, which is at most MAXIMUM_FRAGMENT_COUNT.
static uint64_t allFragments(uint8_t count) {
  return count >= 64 ? UINT64_MAX : (1ULL << count) - 1;
}

bool BurstScheduler::setImage(const uint8_t *image, size_t length, uint32_t version,
                              BurstSummary &ended) {
  const bool interrupted = burstCount_ > 0 && bursts_[0].started;
  if (interrupted) {
    ended = summarize(bursts_[0]);
  }
  image_ = image;
  imageLength_ = length;
  version_ = version;
  burstCount_ = 0;
  // A fragment of the previous image may still be on the air: it keeps the transmitter reserved
  // until it ends.
  return interrupted;
}

bool BurstScheduler::requestFullBurst(uint8_t size, BurstCause cause, uint16_t trigger) {
  if (image_ == nullptr || burstCount_ >= BURST_QUEUE_CAPACITY) {
    return false;
  }
  Burst &burst = bursts_[burstCount_++];
  burst = Burst{};
  burst.cause = cause;
  burst.trigger = trigger;
  burst.size = size;
  burst.count = fragmentCountFor(imageLength_, size);
  burst.pending = allFragments(burst.count);
  return true;
}

bool BurstScheduler::mergeReport(const ReportMessage &report, uint16_t source) {
  if (image_ == nullptr || report.version != version_ ||
      report.count != fragmentCountFor(imageLength_, report.size)) {
    return false;
  }
  uint64_t requested = 0;
  for (uint8_t index = 0; index < report.count; ++index) {
    if (isFragmentMarked(report, index)) {
      requested |= 1ULL << index;
    }
  }
  if (requested == 0) {
    return false;
  }
  for (size_t index = 0; index < burstCount_; ++index) {
    if (bursts_[index].size == report.size) {
      bursts_[index].pending |= requested;
      return true;
    }
  }
  if (burstCount_ >= BURST_QUEUE_CAPACITY) {
    return false;
  }
  Burst &burst = bursts_[burstCount_++];
  burst = Burst{};
  burst.cause = BurstCause::Report;
  burst.trigger = source;
  burst.size = report.size;
  burst.count = report.count;
  burst.pending = requested;
  return true;
}

bool BurstScheduler::takeNextFragment(FragmentMessage &fragment, bool &burstStarted,
                                      BurstSummary &burst) {
  burstStarted = false;
  if (!isFragmentDue()) {
    return false;
  }
  Burst &current = bursts_[0];
  if (current.pending == 0) {
    return false;
  }
  if (!current.started) {
    current.started = true;
    current.initialCount = countPending(current.pending);
    burstStarted = true;
  }
  const uint8_t index = lowestPendingIndex(current.pending);
  current.pending &= ~(1ULL << index);

  const size_t offset = static_cast<size_t>(index) * current.size;
  const size_t rest = imageLength_ - offset;
  fragment.version = version_;
  fragment.index = index;
  fragment.count = current.count;
  fragment.size = current.size;
  fragment.remaining = countPending(current.pending);
  fragment.data = image_ + offset;
  fragment.dataLength = rest < current.size ? rest : current.size;
  fragmentInFlight_ = true;
  fragmentVersion_ = version_;
  if (burstStarted) {
    burst = summarize(current);
  }
  return true;
}

bool BurstScheduler::isFragmentOfCurrentBurst() const {
  return fragmentInFlight_ && fragmentVersion_ == version_ && burstCount_ > 0 && bursts_[0].started;
}

void BurstScheduler::onFragmentStarted(int64_t startMicros) {
  if (isFragmentOfCurrentBurst()) {
    bursts_[0].span.recordStart(startMicros);
  }
}

bool BurstScheduler::onFragmentSent(int64_t endMicros, BurstSummary &ended) {
  const bool current = isFragmentOfCurrentBurst();
  fragmentInFlight_ = false;
  if (!current) {
    return false;
  }
  bursts_[0].span.recordEnd(endMicros);
  if (bursts_[0].pending != 0) {
    return false;
  }
  finishBurst(ended);
  return true;
}

bool BurstScheduler::onFragmentFailed(BurstSummary &ended) {
  const bool current = isFragmentOfCurrentBurst();
  fragmentInFlight_ = false;
  if (!current || bursts_[0].pending != 0) {
    return false;
  }
  finishBurst(ended);
  return true;
}

BurstSummary BurstScheduler::summarize(const Burst &burst) const {
  BurstSummary summary{};
  summary.cause = burst.cause;
  summary.trigger = burst.trigger;
  summary.version = version_;
  summary.size = burst.size;
  summary.initialCount = burst.initialCount;
  summary.sent = burst.span.sentCount();
  summary.durationMicros = burst.span.durationMicros();
  return summary;
}

void BurstScheduler::finishBurst(BurstSummary &ended) {
  ended = summarize(bursts_[0]);
  for (size_t index = 1; index < burstCount_; ++index) {
    bursts_[index - 1] = bursts_[index];
  }
  --burstCount_;
}

} // namespace firmware
