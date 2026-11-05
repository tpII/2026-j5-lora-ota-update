#include "transfer_messages.h"

#include <string.h>

#include "../network/byte_order.h"

namespace firmware {

size_t encodeFragment(const FragmentFields &fields, uint8_t *output) {
  writeUint32(output, fields.version);
  output[4] = fields.index;
  output[5] = fields.count;
  output[6] = fields.size;
  output[7] = fields.remaining;
  memcpy(output + FRAGMENT_HEADER_SIZE, fields.data, fields.dataLength);
  return FRAGMENT_HEADER_SIZE + fields.dataLength;
}

bool decodeFragment(const uint8_t *payload, size_t length, FragmentFields &fields) {
  if (length <= FRAGMENT_HEADER_SIZE) {
    return false;
  }
  fields.version = readUint32(payload);
  fields.index = payload[4];
  fields.count = payload[5];
  fields.size = payload[6];
  fields.remaining = payload[7];
  fields.data = payload + FRAGMENT_HEADER_SIZE;
  fields.dataLength = length - FRAGMENT_HEADER_SIZE;

  if (fields.version == 0 || fields.size < MINIMUM_FRAGMENT_SIZE ||
      fields.size > MAXIMUM_FRAGMENT_SIZE || fields.index >= fields.count ||
      fields.remaining >= fields.count) {
    return false;
  }
  const size_t size = fields.size;
  if (fields.count * size < MINIMUM_IMAGE_SIZE ||
      (fields.count - 1U) * size >= MAXIMUM_IMAGE_SIZE) {
    return false;
  }
  // Every fragment but the last carries exactly size bytes; the last one, from 1 to size, and it
  // does not carry the image past its largest length.
  const bool last = fields.index == fields.count - 1;
  if (!last) {
    return fields.dataLength == size;
  }
  return fields.dataLength <= size &&
         (fields.count - 1U) * size + fields.dataLength <= MAXIMUM_IMAGE_SIZE;
}

size_t encodeReport(const ReportFields &report, uint8_t *output) {
  writeUint32(output, report.version);
  output[4] = report.size;
  output[5] = report.count;
  const size_t bitmapSize = reportBitmapSize(report.count);
  memcpy(output + REPORT_FIXED_SIZE, report.missing, bitmapSize);
  // The bits past the last fragment go out as 0.
  if (report.count % 8 != 0) {
    output[REPORT_FIXED_SIZE + bitmapSize - 1] &=
        static_cast<uint8_t>((1U << (report.count % 8)) - 1);
  }
  return REPORT_FIXED_SIZE + bitmapSize;
}

bool decodeReport(const uint8_t *payload, size_t length, ReportFields &report) {
  if (length < REPORT_FIXED_SIZE) {
    return false;
  }
  report = ReportFields{};
  report.version = readUint32(payload);
  report.size = payload[4];
  report.count = payload[5];
  if (report.version == 0 || report.size < MINIMUM_FRAGMENT_SIZE ||
      report.size > MAXIMUM_FRAGMENT_SIZE || report.count < 1 ||
      report.count > MAXIMUM_FRAGMENT_COUNT ||
      length != REPORT_FIXED_SIZE + reportBitmapSize(report.count)) {
    return false;
  }
  memcpy(report.missing, payload + REPORT_FIXED_SIZE, reportBitmapSize(report.count));
  return true;
}

} // namespace firmware
