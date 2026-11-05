#ifndef J5_TRANSFER_MESSAGES_H
#define J5_TRANSFER_MESSAGES_H

#include <stddef.h>
#include <stdint.h>

#include "../image/image_format.h"
#include "../network/frame.h"

namespace firmware {

// Bodies of FRAGMENT and REPORT (docs/protocol/frame.md and
// docs/adrs/0009-self-describing-fragments.md).

constexpr size_t FRAGMENT_HEADER_SIZE = 8;
constexpr uint8_t MINIMUM_FRAGMENT_SIZE = 32;
constexpr uint8_t MAXIMUM_FRAGMENT_SIZE = MAXIMUM_PAYLOAD_SIZE - FRAGMENT_HEADER_SIZE;
constexpr uint8_t DEFAULT_FRAGMENT_SIZE = MAXIMUM_FRAGMENT_SIZE;
// With the smallest fragment size, the largest image takes this many fragments.
constexpr uint8_t MAXIMUM_FRAGMENT_COUNT =
    (MAXIMUM_IMAGE_SIZE + MINIMUM_FRAGMENT_SIZE - 1) / MINIMUM_FRAGMENT_SIZE;
constexpr size_t REPORT_FIXED_SIZE = 6;
constexpr size_t MAXIMUM_REPORT_BITMAP_SIZE = (MAXIMUM_FRAGMENT_COUNT + 7) / 8;

static_assert(MAXIMUM_FRAGMENT_SIZE == 231, "a fragment carries up to 231 bytes of the image");
static_assert(MAXIMUM_FRAGMENT_COUNT == 35, "a report counts up to 35 fragments");

struct FragmentFields {
  uint32_t version;
  uint8_t index;
  uint8_t count;
  uint8_t size;
  uint8_t remaining;
  const uint8_t *data; // points into the decoded body
  size_t dataLength;
};

struct ReportFields {
  uint32_t version;
  uint8_t size;
  uint8_t count;
  uint8_t missing[MAXIMUM_REPORT_BITMAP_SIZE];
};

// Number of fragments of the given size that an image of the given length takes.
inline uint8_t fragmentCountFor(size_t imageLength, uint8_t size) {
  return static_cast<uint8_t>((imageLength + size - 1) / size);
}

inline size_t reportBitmapSize(uint8_t count) { return (count + 7) / 8; }

// Fragment i is bit i mod 8, least significant first, of byte i / 8.
inline bool isFragmentMarked(const ReportFields &report, uint8_t index) {
  return (report.missing[index / 8] & (1U << (index % 8))) != 0;
}

inline void markFragment(ReportFields &report, uint8_t index) {
  report.missing[index / 8] |= static_cast<uint8_t>(1U << (index % 8));
}

// Writes the header and dataLength bytes of data. Returns the body length.
size_t encodeFragment(const FragmentFields &fields, uint8_t *output);
// Applies every validity rule of the contract; data points into the payload.
bool decodeFragment(const uint8_t *payload, size_t length, FragmentFields &fields);

size_t encodeReport(const ReportFields &report, uint8_t *output);
bool decodeReport(const uint8_t *payload, size_t length, ReportFields &report);

} // namespace firmware

#endif
