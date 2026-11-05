#ifndef J5_IMAGE_RECEPTION_H
#define J5_IMAGE_RECEPTION_H

#include <stddef.h>
#include <stdint.h>

#include "../image/image_format.h"
#include "transfer_messages.h"

namespace firmware {

struct FragmentReceipt {
  bool accepted;    // the fragment belongs to the reception in progress
  bool contributed; // it supplied at least one byte that was missing
  bool started; // it opened a reception: the first one, a newer version or after a contradiction
};

// The reception in progress of one image (docs/protocol/frame.md, "Transferencia de imágenes").
// It records which bytes of the image have arrived, not which fragments, so fragments of different
// sizes combine. Until the last fragment arrives the exact length is unknown: every fragment bounds
// it, and a fragment that leaves no possible length restarts the reception. The reception also
// keeps the two report deadlines: the expected end of the burst and the repeat of a report.
class ImageReception {
public:
  void reset();

  bool isActive() const { return active_; }
  uint32_t version() const { return version_; }

  // Offers a fragment that the caller already found newer than the available version. A fragment
  // of a version older than the reception is ignored; a newer one replaces the reception.
  // fragmentAirMillis is the time on air of a full fragment of this size.
  FragmentReceipt offer(uint16_t source, const FragmentFields &fields, uint32_t nowMillis,
                        uint32_t fragmentAirMillis);

  bool isLengthKnown() const { return active_ && upperBound_ == lowerBound_ + 1; }
  bool isComplete() const;
  // Valid once the length is known.
  size_t imageLength() const { return upperBound_; }
  const uint8_t *image() const { return image_; }
  // Missing bytes up to the end of the image or, while its length is unknown, up to the smallest
  // end that the fragments allow.
  size_t missingByteCount() const;

  // The report for the size and count of the last fragment received: every fragment with a missing
  // byte, and the last fragment while the exact length is unknown.
  void buildReport(ReportFields &report) const;

  // Between a fragment with fragments still to come and the expected end of its burst.
  bool isBurstInProgress(uint32_t nowMillis) const;
  // After the last fragment of a burst, when the burst deadline expires or when a report got no
  // fragment in reply, while bytes are missing.
  bool isReportDue(uint32_t nowMillis) const;
  // The report goes out: repeat it after repeatTimeoutMillis unless a fragment arrives.
  void onReportSent(uint32_t nowMillis, uint32_t repeatTimeoutMillis);

  uint16_t lastSource() const { return lastSource_; }
  uint16_t fragmentCount() const { return fragments_; }
  uint16_t reportCount() const { return reports_; }
  uint32_t startMillis() const { return startMillis_; }

private:
  void start(uint32_t version, uint32_t nowMillis);
  // Narrows the bounds of the image length with the fragment. Returns false when no length is left.
  static bool narrowBounds(const FragmentFields &fields, size_t &lowerBound, size_t &upperBound);
  bool isCovered(size_t offset, size_t length) const;

  uint8_t image_[MAXIMUM_IMAGE_SIZE] = {};
  uint8_t coverage_[(MAXIMUM_IMAGE_SIZE + 7) / 8] = {};
  bool active_ = false;
  uint32_t version_ = 0;
  // The image length is greater than lowerBound_ and at most upperBound_.
  size_t lowerBound_ = 0;
  size_t upperBound_ = 0;
  uint16_t lastSource_ = 0;
  uint8_t lastSize_ = 0;
  uint8_t lastCount_ = 0;
  uint16_t fragments_ = 0;
  uint16_t reports_ = 0;
  uint32_t startMillis_ = 0;
  bool burstOpen_ = false;
  bool reportRequested_ = false;
  bool deadlineArmed_ = false;
  uint32_t deadlineMillis_ = 0;
};

} // namespace firmware

#endif
