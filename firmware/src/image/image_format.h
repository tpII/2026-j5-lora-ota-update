#ifndef J5_IMAGE_FORMAT_H
#define J5_IMAGE_FORMAT_H

#include <stddef.h>
#include <stdint.h>

#include "../vm/virtual_machine.h"

namespace firmware {

// Signed image: header, VM program and Ed25519 signature (docs/protocol/image.md).

constexpr uint8_t IMAGE_MAGIC_FIRST = 0x4A;  // 'J'
constexpr uint8_t IMAGE_MAGIC_SECOND = 0x35; // '5'
constexpr size_t IMAGE_HEADER_SIZE = 9;
constexpr size_t IMAGE_SIGNATURE_SIZE = 64;
constexpr size_t IMAGE_PROGRAM_DIGEST_SIZE = 32;
constexpr size_t IMAGE_SIGNED_MESSAGE_SIZE = IMAGE_HEADER_SIZE + IMAGE_PROGRAM_DIGEST_SIZE;
constexpr size_t OPERATOR_PUBLIC_KEY_SIZE = 32;
constexpr size_t MINIMUM_IMAGE_SIZE = IMAGE_HEADER_SIZE + 1 + IMAGE_SIGNATURE_SIZE;
constexpr size_t MAXIMUM_IMAGE_SIZE = IMAGE_HEADER_SIZE + PROGRAM_CAPACITY + IMAGE_SIGNATURE_SIZE;

struct ImageHeader {
  uint8_t flags;
  uint32_t version;
  uint16_t programLength;
};

} // namespace firmware

#endif
