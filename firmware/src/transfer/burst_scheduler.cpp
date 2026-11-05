#include "burst_scheduler.h"

namespace firmware {

static uint8_t countPending(uint64_t pending) {
  return static_cast<uint8_t>(__builtin_popcountll(pending));
}

static uint8_t lowestPendingIndex(uint64_t pending) {
  return static_cast<uint8_t>(__builtin_ctzll(pending));
}

// Every fragment of a count; at most MAXIMUM_FRAGMENT_COUNT, so it fits the 64 bits.
static uint64_t allFragments(uint8_t count) { return (1ULL << count) - 1; }

const char *burstCauseName(BurstCause cause) {
  switch (cause) {
  case BurstCause::Load:
    return "load";
  case BurstCause::Complete:
    return "complete";
  case BurstCause::Hello:
    return "hello";
  case BurstCause::Report:
    return "report";
  }
  return "load";
}

void BurstScheduler::setImage(const uint8_t *image, size_t length, uint32_t version) {
  image_ = image;
  imageLength_ = length;
  version_ = version;
  burstCount_ = 0;
  // A fragment of the previous image may still be on the air: it keeps the transmitter reserved
  // until it ends.
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

bool BurstScheduler::mergeReport(const ReportFields &report, uint16_t source) {
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

size_t BurstScheduler::buildNextFragment(uint8_t *output, bool &burstStarted) {
  burstStarted = false;
  if (!isFragmentDue()) {
    return 0;
  }
  Burst &burst = bursts_[0];
  if (burst.pending == 0) {
    return 0;
  }
  if (!burst.started) {
    burst.started = true;
    burst.initialCount = countPending(burst.pending);
    burstStarted = true;
  }
  const uint8_t index = lowestPendingIndex(burst.pending);
  burst.pending &= ~(1ULL << index);

  const size_t offset = static_cast<size_t>(index) * burst.size;
  const size_t rest = imageLength_ - offset;
  FragmentFields fields{};
  fields.version = version_;
  fields.index = index;
  fields.count = burst.count;
  fields.size = burst.size;
  fields.remaining = countPending(burst.pending);
  fields.data = image_ + offset;
  fields.dataLength = rest < burst.size ? rest : burst.size;
  fragmentInFlight_ = true;
  return encodeFragment(fields, output);
}

void BurstScheduler::onFragmentStarted(int64_t startMicros) {
  if (burstCount_ == 0 || !bursts_[0].started || bursts_[0].timed) {
    return;
  }
  bursts_[0].timed = true;
  bursts_[0].firstStartMicros = startMicros;
}

bool BurstScheduler::onFragmentSent(uint32_t version, int64_t endMicros) {
  if (!fragmentInFlight_) {
    return false;
  }
  fragmentInFlight_ = false;
  if (version != version_ || burstCount_ == 0 || !bursts_[0].started) {
    return false;
  }
  Burst &burst = bursts_[0];
  ++burst.sent;
  burst.lastEndMicros = endMicros;
  return burst.pending == 0;
}

bool BurstScheduler::onFragmentFailed(uint32_t version) {
  if (!fragmentInFlight_) {
    return false;
  }
  fragmentInFlight_ = false;
  // The fragment is not sent again: a report asks for it if a receiver misses it.
  return version == version_ && burstCount_ > 0 && bursts_[0].started && bursts_[0].pending == 0;
}

void BurstScheduler::finishBurst() {
  if (burstCount_ == 0) {
    return;
  }
  for (size_t index = 1; index < burstCount_; ++index) {
    bursts_[index - 1] = bursts_[index];
  }
  --burstCount_;
}

} // namespace firmware
