#include "report_message.h"

#include <string.h>

#include "../encoding/byte_order.h"

namespace firmware {

size_t encodeReport(const ReportMessage &report, uint8_t *output) {
  writeUint32(output + REPORT_VERSION_OFFSET, report.version);
  output[REPORT_SIZE_OFFSET] = report.size;
  output[REPORT_COUNT_OFFSET] = report.count;
  const size_t bitmapSize = reportBitmapSize(report.count);
  memcpy(output + REPORT_FIXED_SIZE, report.missing, bitmapSize);
  if (report.count % 8 != 0) {
    output[REPORT_FIXED_SIZE + bitmapSize - 1] &=
        static_cast<uint8_t>((1U << (report.count % 8)) - 1);
  }
  return REPORT_FIXED_SIZE + bitmapSize;
}

bool decodeReport(const uint8_t *payload, size_t length, ReportMessage &report) {
  if (length < REPORT_FIXED_SIZE) {
    return false;
  }
  report = ReportMessage{};
  report.version = readUint32(payload + REPORT_VERSION_OFFSET);
  report.size = payload[REPORT_SIZE_OFFSET];
  report.count = payload[REPORT_COUNT_OFFSET];
  if (report.version < MINIMUM_IMAGE_VERSION || report.size < MINIMUM_FRAGMENT_SIZE ||
      report.size > MAXIMUM_FRAGMENT_SIZE || report.count < 1 ||
      report.count > MAXIMUM_FRAGMENT_COUNT ||
      length != REPORT_FIXED_SIZE + reportBitmapSize(report.count)) {
    return false;
  }
  memcpy(report.missing, payload + REPORT_FIXED_SIZE, reportBitmapSize(report.count));
  return true;
}

} // namespace firmware
