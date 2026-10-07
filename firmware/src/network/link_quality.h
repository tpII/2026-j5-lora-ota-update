#ifndef J5_LINK_QUALITY_H
#define J5_LINK_QUALITY_H

#include <math.h>
#include <stdint.h>

namespace j5 {

// RSSI travels as whole dBm with the sign changed, and SNR as signed quarters of a dB
// (docs/protocol/frame.md).

inline uint8_t encodeRssi(float rssi) {
  long value = lroundf(-rssi);
  if (value < 0) {
    value = 0;
  } else if (value > 255) {
    value = 255;
  }
  return static_cast<uint8_t>(value);
}

inline int16_t decodeRssi(uint8_t value) { return -static_cast<int16_t>(value); }

inline uint8_t encodeSnr(float snr) {
  long value = lroundf(snr * 4.0f);
  if (value < -128) {
    value = -128;
  } else if (value > 127) {
    value = 127;
  }
  return static_cast<uint8_t>(static_cast<int8_t>(value));
}

inline float decodeSnr(uint8_t value) { return static_cast<int8_t>(value) / 4.0f; }

} // namespace j5

#endif
