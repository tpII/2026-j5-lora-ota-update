#ifndef J5_RADIO_SETTINGS_H
#define J5_RADIO_SETTINGS_H

#include <stddef.h>
#include <stdint.h>

#include "../board/board_support.h"

namespace j5 {

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

RadioSettings defaultRadioSettings();

enum class SettingUpdate : uint8_t {
  Accepted,
  UnknownKey,
  InvalidValue,
  OutOfRange,
  UnreachablePower,
  NotSupported
};

// Applies one key/value pair of the radio command to the settings. On failure the settings are
// left untouched and the detail buffer describes the accepted range.
SettingUpdate updateRadioSetting(RadioSettings &settings, const char *key, const char *value,
                                 const BoardSupport &board, char *detail, size_t detailCapacity);

// Reason of the console error event for a failed update.
const char *settingUpdateReason(SettingUpdate update);

} // namespace j5

#endif
