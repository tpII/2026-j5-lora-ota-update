#include "test_message.h"

#include <string.h>

#include "../encoding/byte_order.h"

namespace firmware {

static_assert(MINIMUM_TEST_SIZE >= TEST_FIELDS_SIZE,
              "every run the console accepts fits its fields");

size_t encodeTest(const TestMessage &message, uint8_t *output) {
  memset(output, 0, message.size);
  writeUint16(output + TEST_RUN_OFFSET, message.run);
  writeUint16(output + TEST_INDEX_OFFSET, message.index);
  writeUint16(output + TEST_COUNT_OFFSET, message.count);
  writeUint16(output + TEST_INTERVAL_OFFSET, message.interval);
  return message.size;
}

bool decodeTest(const uint8_t *payload, size_t length, TestMessage &message) {
  if (length < TEST_FIELDS_SIZE) {
    return false;
  }
  message.run = readUint16(payload + TEST_RUN_OFFSET);
  message.index = readUint16(payload + TEST_INDEX_OFFSET);
  message.count = readUint16(payload + TEST_COUNT_OFFSET);
  message.interval = readUint16(payload + TEST_INTERVAL_OFFSET);
  message.size = static_cast<uint16_t>(length);
  return message.count > 0 && message.index < message.count;
}

} // namespace firmware
