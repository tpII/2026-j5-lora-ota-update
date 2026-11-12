#include "fragment_message.h"

#include <string.h>

#include "../encoding/byte_order.h"

namespace firmware {

size_t encodeFragment(const FragmentMessage &message, uint8_t *output) {
  writeUint32(output + FRAGMENT_VERSION_OFFSET, message.version);
  output[FRAGMENT_INDEX_OFFSET] = message.index;
  output[FRAGMENT_COUNT_OFFSET] = message.count;
  output[FRAGMENT_SIZE_OFFSET] = message.size;
  output[FRAGMENT_REMAINING_OFFSET] = message.remaining;
  memcpy(output + FRAGMENT_HEADER_SIZE, message.data, message.dataLength);
  return FRAGMENT_HEADER_SIZE + message.dataLength;
}

bool decodeFragment(const uint8_t *payload, size_t length, FragmentMessage &message) {
  if (length <= FRAGMENT_HEADER_SIZE) {
    return false;
  }
  message.version = readUint32(payload + FRAGMENT_VERSION_OFFSET);
  message.index = payload[FRAGMENT_INDEX_OFFSET];
  message.count = payload[FRAGMENT_COUNT_OFFSET];
  message.size = payload[FRAGMENT_SIZE_OFFSET];
  message.remaining = payload[FRAGMENT_REMAINING_OFFSET];
  message.data = payload + FRAGMENT_HEADER_SIZE;
  message.dataLength = length - FRAGMENT_HEADER_SIZE;

  if (message.version < MINIMUM_IMAGE_VERSION || message.size < MINIMUM_FRAGMENT_SIZE ||
      message.size > MAXIMUM_FRAGMENT_SIZE || message.index >= message.count ||
      message.remaining >= message.count) {
    return false;
  }
  const size_t size = message.size;
  if (message.count * size < MINIMUM_IMAGE_SIZE ||
      (message.count - 1U) * size >= MAXIMUM_IMAGE_SIZE) {
    return false;
  }
  // Every fragment but the last carries exactly size bytes; the last one, from 1 to size, and it
  // does not carry the image past its largest length.
  const bool last = message.index == message.count - 1;
  if (!last) {
    return message.dataLength == size;
  }
  return message.dataLength <= size &&
         (message.count - 1U) * size + message.dataLength <= MAXIMUM_IMAGE_SIZE;
}

} // namespace firmware
