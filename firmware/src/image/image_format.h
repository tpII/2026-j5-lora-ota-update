#ifndef J5_IMAGE_FORMAT_H
#define J5_IMAGE_FORMAT_H

#include <stdint.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

// Signed image: header, VM program and Ed25519 signature (docs/protocol/image.md). Its sizes and
// offsets are in the protocol contract.

struct ImageHeader {
  uint8_t flags;
  uint32_t version;
  uint16_t programLength;
};

} // namespace firmware

#endif
