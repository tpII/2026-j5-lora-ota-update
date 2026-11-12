#ifndef J5_REPORT_MESSAGE_H
#define J5_REPORT_MESSAGE_H

#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

// Body of a REPORT (docs/protocol/frame.md and docs/adrs/0010-receiver-driven-repair.md): the
// fragments of one size that a receiver misses. Its sizes and offsets are in the protocol
// contract.
struct ReportMessage {
  uint32_t version;
  uint8_t size;
  uint8_t count;
  uint8_t missing[MAXIMUM_REPORT_BITMAP_SIZE];
};

constexpr size_t reportBitmapSize(uint8_t count) { return (count + 7) / 8; }

// Length of the whole frame of a report on count fragments.
constexpr size_t reportFrameLength(uint8_t count) {
  return FRAME_OVERHEAD + REPORT_FIXED_SIZE + reportBitmapSize(count);
}

// Fragment i is bit i mod 8, least significant first, of byte i / 8.
inline bool isFragmentMarked(const ReportMessage &report, uint8_t index) {
  return (report.missing[index / 8] & (1U << (index % 8))) != 0;
}

inline void markFragment(ReportMessage &report, uint8_t index) {
  report.missing[index / 8] |= static_cast<uint8_t>(1U << (index % 8));
}

// Writes the body with the bits past the last fragment as 0. Returns the body length.
size_t encodeReport(const ReportMessage &report, uint8_t *output);
bool decodeReport(const uint8_t *payload, size_t length, ReportMessage &report);

} // namespace firmware

#endif
