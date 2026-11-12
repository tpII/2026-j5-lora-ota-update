#ifndef J5_FRAGMENT_MESSAGE_H
#define J5_FRAGMENT_MESSAGE_H

#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

// Body of a FRAGMENT (docs/protocol/frame.md and docs/adrs/0009-self-describing-fragments.md). Its
// sizes and offsets are in the protocol contract.
struct FragmentMessage {
  uint32_t version;
  uint8_t index;
  uint8_t count;
  uint8_t size;
  uint8_t remaining;
  const uint8_t *data; // points into the image when encoding, into the body when decoding
  size_t dataLength;
};

// The count fits uint8_t: with size >= MINIMUM_FRAGMENT_SIZE and imageLength <=
// MAXIMUM_IMAGE_SIZE it is at most MAXIMUM_FRAGMENT_COUNT.
inline uint8_t fragmentCountFor(size_t imageLength, uint8_t size) {
  return static_cast<uint8_t>((imageLength + size - 1) / size);
}

// Length of the whole frame of a fragment that carries size bytes of the image.
constexpr size_t fragmentFrameLength(uint8_t size) {
  return FRAME_OVERHEAD + FRAGMENT_HEADER_SIZE + size;
}

// Writes the header and dataLength bytes of data. Returns the body length.
size_t encodeFragment(const FragmentMessage &message, uint8_t *output);
// Applies every validity rule of the contract; data points into the payload.
bool decodeFragment(const uint8_t *payload, size_t length, FragmentMessage &message);

} // namespace firmware

#endif
