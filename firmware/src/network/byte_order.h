#ifndef J5_BYTE_ORDER_H
#define J5_BYTE_ORDER_H

#include <stdint.h>

namespace j5 {

// Multi-byte fields travel in little-endian order (docs/protocol/frame.md).

inline void writeUint16(uint8_t *output, uint16_t value) {
  output[0] = static_cast<uint8_t>(value & 0xFF);
  output[1] = static_cast<uint8_t>(value >> 8);
}

inline uint16_t readUint16(const uint8_t *input) {
  return static_cast<uint16_t>(input[0] | (static_cast<uint16_t>(input[1]) << 8));
}

inline void writeUint32(uint8_t *output, uint32_t value) {
  for (int index = 0; index < 4; ++index) {
    output[index] = static_cast<uint8_t>((value >> (8 * index)) & 0xFF);
  }
}

inline uint32_t readUint32(const uint8_t *input) {
  uint32_t value = 0;
  for (int index = 0; index < 4; ++index) {
    value |= static_cast<uint32_t>(input[index]) << (8 * index);
  }
  return value;
}

} // namespace j5

#endif
