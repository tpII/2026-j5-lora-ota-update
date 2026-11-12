#ifndef J5_RECEIVED_FRAME_H
#define J5_RECEIVED_FRAME_H

#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

// A frame as the radio received it, with how it arrived.
struct ReceivedFrame {
  uint8_t data[MAXIMUM_FRAME_SIZE];
  size_t length;
  float rssi;
  float snr;
  float frequencyError;
  bool integrityVerified;
  int64_t receivedAtMicros;
};

} // namespace firmware

#endif
