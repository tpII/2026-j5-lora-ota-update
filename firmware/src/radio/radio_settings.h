#ifndef J5_RADIO_SETTINGS_H
#define J5_RADIO_SETTINGS_H

#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

// Radio settings of a node (docs/protocol/radio.md). The transmit power is the power at the
// antenna connector; the board translates it to the transceiver setting.
struct RadioSettings {
  float frequencyMhz;
  uint8_t spreadingFactor;
  uint16_t bandwidthKhz;
  uint8_t codingRateDenominator;
  uint16_t preambleLength;
  uint8_t syncWord;
  int8_t transmitPowerDbm;
  bool lowNoiseAmplifierEnabled;
};

constexpr RadioSettings defaultRadioSettings() {
  return RadioSettings{DEFAULT_FREQUENCY_MHZ,      DEFAULT_SPREADING_FACTOR,
                       DEFAULT_BANDWIDTH_KHZ,      DEFAULT_CODING_RATE_DENOMINATOR,
                       DEFAULT_PREAMBLE_LENGTH,    DEFAULT_SYNC_WORD,
                       DEFAULT_TRANSMIT_POWER_DBM, DEFAULT_LNA_MODE == LnaMode::On};
}

} // namespace firmware

#endif
