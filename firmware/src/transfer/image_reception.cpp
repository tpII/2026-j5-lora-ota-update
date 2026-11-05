#include "image_reception.h"

#include <string.h>

#include "../configuration.h"

namespace firmware {

// Signed, because the main loop reads the clock once per pass.
static bool hasReached(uint32_t nowMillis, uint32_t deadlineMillis) {
  return static_cast<int32_t>(nowMillis - deadlineMillis) >= 0;
}

void ImageReception::reset() {
  active_ = false;
  version_ = 0;
  burstOpen_ = false;
  reportRequested_ = false;
  deadlineArmed_ = false;
}

void ImageReception::start(uint32_t version, uint32_t nowMillis) {
  memset(coverage_, 0, sizeof(coverage_));
  active_ = true;
  version_ = version;
  // Only the largest image bounds the length: a shorter image than the smallest one is received
  // whole and then fails the verification for format.
  lowerBound_ = 0;
  upperBound_ = MAXIMUM_IMAGE_SIZE;
  fragments_ = 0;
  reports_ = 0;
  startMillis_ = nowMillis;
  burstOpen_ = false;
  reportRequested_ = false;
  deadlineArmed_ = false;
}

bool ImageReception::narrowBounds(const FragmentFields &fields, size_t &lowerBound,
                                  size_t &upperBound) {
  const size_t size = fields.size;
  size_t fragmentLower = 0;
  size_t fragmentUpper = 0;
  if (fields.index == fields.count - 1) {
    // The last fragment gives the exact length.
    fragmentUpper = (fields.count - 1U) * size + fields.dataLength;
    fragmentLower = fragmentUpper - 1;
  } else {
    // Any other fragment: the last one holds from 1 to size bytes.
    fragmentLower = (fields.count - 1U) * size;
    fragmentUpper = fields.count * size;
  }
  const size_t lower = fragmentLower > lowerBound ? fragmentLower : lowerBound;
  const size_t upper = fragmentUpper < upperBound ? fragmentUpper : upperBound;
  if (lower >= upper) {
    return false;
  }
  lowerBound = lower;
  upperBound = upper;
  return true;
}

FragmentReceipt ImageReception::offer(uint16_t source, const FragmentFields &fields,
                                      uint32_t nowMillis, uint32_t fragmentAirMillis) {
  FragmentReceipt receipt{};
  // A fragment that no image could contain, a last fragment that ends past the largest image, is
  // ignored without touching the reception. decodeFragment already rejects it; the check keeps
  // the writes inside the buffer.
  size_t aloneLower = 0;
  size_t aloneUpper = MAXIMUM_IMAGE_SIZE;
  if (!narrowBounds(fields, aloneLower, aloneUpper)) {
    return receipt;
  }
  if (active_ && fields.version < version_) {
    return receipt;
  }
  if (!active_ || fields.version > version_) {
    start(fields.version, nowMillis);
    receipt.started = true;
  }
  size_t lower = lowerBound_;
  size_t upper = upperBound_;
  if (!narrowBounds(fields, lower, upper)) {
    // The fragment contradicts the length known so far: start again with it.
    start(fields.version, nowMillis);
    receipt.started = true;
    lower = aloneLower;
    upper = aloneUpper;
  }
  lowerBound_ = lower;
  upperBound_ = upper;

  const size_t offset = static_cast<size_t>(fields.index) * fields.size;
  for (size_t position = offset; position < offset + fields.dataLength; ++position) {
    const uint8_t mask = static_cast<uint8_t>(1U << (position % 8));
    if ((coverage_[position / 8] & mask) == 0) {
      coverage_[position / 8] |= mask;
      image_[position] = fields.data[position - offset];
      receipt.contributed = true;
    }
  }

  receipt.accepted = true;
  ++fragments_;
  lastSource_ = source;
  lastSize_ = fields.size;
  lastCount_ = fields.count;
  if (fields.remaining == 0) {
    burstOpen_ = false;
    deadlineArmed_ = false;
    reportRequested_ = true;
  } else {
    burstOpen_ = true;
    deadlineArmed_ = true;
    deadlineMillis_ = nowMillis + fields.remaining * fragmentAirMillis + TRANSFER_MARGIN_MS;
    reportRequested_ = false;
  }
  return receipt;
}

bool ImageReception::isCovered(size_t offset, size_t length) const {
  for (size_t position = offset; position < offset + length; ++position) {
    if ((coverage_[position / 8] & (1U << (position % 8))) == 0) {
      return false;
    }
  }
  return true;
}

bool ImageReception::isComplete() const { return isLengthKnown() && isCovered(0, upperBound_); }

size_t ImageReception::missingByteCount() const {
  if (!active_) {
    return 0;
  }
  size_t missing = 0;
  for (size_t position = 0; position < upperBound_; ++position) {
    if ((coverage_[position / 8] & (1U << (position % 8))) == 0) {
      ++missing;
    }
  }
  return missing;
}

void ImageReception::buildReport(ReportFields &report) const {
  report = ReportFields{};
  report.version = version_;
  report.size = lastSize_;
  report.count = lastCount_;
  const bool lengthKnown = isLengthKnown();
  for (uint8_t index = 0; index < lastCount_; ++index) {
    const size_t offset = static_cast<size_t>(index) * lastSize_;
    const bool last = index == lastCount_ - 1;
    if (last && !lengthKnown) {
      markFragment(report, index);
      continue;
    }
    const size_t end = last ? upperBound_ : offset + lastSize_;
    if (!isCovered(offset, end - offset)) {
      markFragment(report, index);
    }
  }
}

bool ImageReception::isBurstInProgress(uint32_t nowMillis) const {
  return active_ && burstOpen_ && deadlineArmed_ && !hasReached(nowMillis, deadlineMillis_);
}

bool ImageReception::isReportDue(uint32_t nowMillis) const {
  if (!active_ || isComplete()) {
    return false;
  }
  return reportRequested_ || (deadlineArmed_ && hasReached(nowMillis, deadlineMillis_));
}

void ImageReception::onReportSent(uint32_t nowMillis, uint32_t repeatTimeoutMillis) {
  ++reports_;
  burstOpen_ = false;
  reportRequested_ = false;
  deadlineArmed_ = true;
  deadlineMillis_ = nowMillis + repeatTimeoutMillis;
}

} // namespace firmware
