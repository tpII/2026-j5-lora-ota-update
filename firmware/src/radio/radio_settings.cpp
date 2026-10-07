#include "radio_settings.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace j5 {

namespace {

constexpr float MINIMUM_FREQUENCY_MHZ = 915.0f;
constexpr float MAXIMUM_FREQUENCY_MHZ = 928.0f;

bool parseInteger(const char *text, long &value) {
  if (text == nullptr || *text == '\0') {
    return false;
  }
  char *end = nullptr;
  errno = 0;
  value = strtol(text, &end, 0);
  return errno == 0 && end != nullptr && *end == '\0';
}

bool parseDecimal(const char *text, float &value) {
  if (text == nullptr || *text == '\0') {
    return false;
  }
  char *end = nullptr;
  errno = 0;
  value = strtof(text, &end);
  return errno == 0 && end != nullptr && *end == '\0';
}

SettingUpdate rejectRange(char *detail, size_t detailCapacity, const char *range) {
  snprintf(detail, detailCapacity, "%s", range);
  return SettingUpdate::OutOfRange;
}

SettingUpdate rejectValue(char *detail, size_t detailCapacity, const char *usage) {
  snprintf(detail, detailCapacity, "%s", usage);
  return SettingUpdate::InvalidValue;
}

} // namespace

RadioSettings defaultRadioSettings() {
  RadioSettings settings{};
  settings.frequencyMhz = 915.9f;
  settings.spreadingFactor = 7;
  settings.bandwidthKhz = 500;
  settings.codingRateDenominator = 5;
  settings.preambleLength = 8;
  settings.syncWord = 0x12;
  settings.transmitPowerDbm = 4;
  settings.lowNoiseAmplifierEnabled = false;
  return settings;
}

SettingUpdate updateRadioSetting(RadioSettings &settings, const char *key, const char *value,
                                 const BoardSupport &board, char *detail, size_t detailCapacity) {
  detail[0] = '\0';
  long integer = 0;

  if (strcmp(key, "freq") == 0) {
    float frequency = 0.0f;
    if (!parseDecimal(value, frequency)) {
      return rejectValue(detail, detailCapacity, "freq <MHz>");
    }
    if (frequency < MINIMUM_FREQUENCY_MHZ || frequency > MAXIMUM_FREQUENCY_MHZ) {
      return rejectRange(detail, detailCapacity, "freq 915.0..928.0");
    }
    settings.frequencyMhz = frequency;
    return SettingUpdate::Accepted;
  }

  if (strcmp(key, "lna") == 0) {
    if (!board.hasLowNoiseAmplifier()) {
      snprintf(detail, detailCapacity, "lna exists only on V4.3");
      return SettingUpdate::NotSupported;
    }
    if (strcmp(value, "on") == 0) {
      settings.lowNoiseAmplifierEnabled = true;
    } else if (strcmp(value, "bypass") == 0) {
      settings.lowNoiseAmplifierEnabled = false;
    } else {
      return rejectValue(detail, detailCapacity, "lna on|bypass");
    }
    return SettingUpdate::Accepted;
  }

  if (strcmp(key, "sf") == 0) {
    if (!parseInteger(value, integer)) {
      return rejectValue(detail, detailCapacity, "sf <7..12>");
    }
    if (integer < 7 || integer > 12) {
      return rejectRange(detail, detailCapacity, "sf 7..12");
    }
    settings.spreadingFactor = static_cast<uint8_t>(integer);
    return SettingUpdate::Accepted;
  }

  if (strcmp(key, "bw") == 0) {
    if (!parseInteger(value, integer)) {
      return rejectValue(detail, detailCapacity, "bw <kHz>");
    }
    if (integer != 125 && integer != 250 && integer != 500) {
      return rejectRange(detail, detailCapacity, "bw 125, 250 or 500");
    }
    settings.bandwidthKhz = static_cast<uint16_t>(integer);
    return SettingUpdate::Accepted;
  }

  if (strcmp(key, "cr") == 0) {
    if (!parseInteger(value, integer)) {
      return rejectValue(detail, detailCapacity, "cr <5..8>");
    }
    if (integer < 5 || integer > 8) {
      return rejectRange(detail, detailCapacity, "cr 5..8");
    }
    settings.codingRateDenominator = static_cast<uint8_t>(integer);
    return SettingUpdate::Accepted;
  }

  if (strcmp(key, "preamble") == 0) {
    if (!parseInteger(value, integer)) {
      return rejectValue(detail, detailCapacity, "preamble <symbols>");
    }
    if (integer < 6 || integer > 65535) {
      return rejectRange(detail, detailCapacity, "preamble 6..65535");
    }
    settings.preambleLength = static_cast<uint16_t>(integer);
    return SettingUpdate::Accepted;
  }

  if (strcmp(key, "sync") == 0) {
    if (!parseInteger(value, integer)) {
      return rejectValue(detail, detailCapacity, "sync <0..255>");
    }
    if (integer < 0 || integer > 255) {
      return rejectRange(detail, detailCapacity, "sync 0..255");
    }
    settings.syncWord = static_cast<uint8_t>(integer);
    return SettingUpdate::Accepted;
  }

  if (strcmp(key, "power") == 0) {
    if (!parseInteger(value, integer)) {
      return rejectValue(detail, detailCapacity, "power <dBm>");
    }
    if (integer < -128 || integer > 127 || !board.isTransmitPowerReachable(integer)) {
      snprintf(detail, detailCapacity, "%s", board.transmitPowerRange());
      return SettingUpdate::UnreachablePower;
    }
    settings.transmitPowerDbm = static_cast<int8_t>(integer);
    return SettingUpdate::Accepted;
  }

  snprintf(detail, detailCapacity, "unknown key %s", key);
  return SettingUpdate::UnknownKey;
}

const char *settingUpdateReason(SettingUpdate update) {
  switch (update) {
  case SettingUpdate::Accepted:
    return nullptr;
  case SettingUpdate::UnknownKey:
  case SettingUpdate::InvalidValue:
    return "usage";
  case SettingUpdate::OutOfRange:
    return "out_of_range";
  case SettingUpdate::UnreachablePower:
    return "unreachable_power";
  case SettingUpdate::NotSupported:
    return "not_supported";
  }
  return "usage";
}

} // namespace j5
