#include "radio_command.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "../console/argument_reader.h"

namespace firmware {

static constexpr SettingUpdate SETTING_UPDATE_FAILURES[] = {
    SettingUpdate::UnknownKey,       SettingUpdate::InvalidValue, SettingUpdate::OutOfRange,
    SettingUpdate::UnreachablePower, SettingUpdate::NotSupported,
};

static constexpr bool isSettingUpdateReason(ErrorReason reason) {
  for (const ErrorReason candidate : SETTING_UPDATE_REASONS) {
    if (candidate == reason) {
      return true;
    }
  }
  return false;
}

// The failures give the reasons of the contract, and every reason of the contract is given by
// some failure, so the control panel builds its schema from the same list.
static constexpr bool doFailuresGiveContractReasons() {
  for (const SettingUpdate failure : SETTING_UPDATE_FAILURES) {
    if (!isSettingUpdateReason(settingUpdateReason(failure))) {
      return false;
    }
  }
  for (const ErrorReason reason : SETTING_UPDATE_REASONS) {
    bool given = false;
    for (const SettingUpdate failure : SETTING_UPDATE_FAILURES) {
      given = given || settingUpdateReason(failure) == reason;
    }
    if (!given) {
      return false;
    }
  }
  return true;
}

static_assert(doFailuresGiveContractReasons(),
              "the failed setting updates must give exactly SETTING_UPDATE_REASONS");

// Appends formatted text at position, as far as the capacity allows, and returns the new position.
static size_t appendText(char *detail, size_t detailCapacity, size_t position, const char *format,
                         ...) __attribute__((format(printf, 4, 5)));

static size_t appendText(char *detail, size_t detailCapacity, size_t position, const char *format,
                         ...) {
  if (position >= detailCapacity) {
    return position;
  }
  va_list arguments;
  va_start(arguments, format);
  const int written = vsnprintf(detail + position, detailCapacity - position, format, arguments);
  va_end(arguments);
  return written > 0 ? position + static_cast<size_t>(written) : position;
}

static const char *listSeparator(size_t index, size_t count) {
  if (index == 0) {
    return "";
  }
  return index + 1 < count ? ", " : " or ";
}

static bool findRadioSettingKey(const char *name, RadioSettingKey &key) {
  for (size_t index = 0; index < RADIO_SETTING_KEY_COUNT; ++index) {
    const RadioSettingKey candidate = static_cast<RadioSettingKey>(index);
    if (strcmp(radioSettingKeyName(candidate), name) == 0) {
      key = candidate;
      return true;
    }
  }
  return false;
}

// The usage of the key, such as "power <dBm>", for a value that is not one at all.
static SettingUpdate rejectValue(char *detail, size_t detailCapacity, const char *key,
                                 const char *valueUsage) {
  snprintf(detail, detailCapacity, "%s %s", key, valueUsage);
  return SettingUpdate::InvalidValue;
}

// An integer from minimum to maximum. A value that is no number answers the usage of the key:
// valueUsage, or "<minimum..maximum>" when it is nullptr.
static SettingUpdate readInteger(const char *key, const char *value, uint32_t minimum,
                                 uint32_t maximum, const char *valueUsage, uint32_t &integer,
                                 char *detail, size_t detailCapacity) {
  uint64_t number = 0;
  if (!parseUnsignedNumber(value, number)) {
    if (valueUsage != nullptr) {
      return rejectValue(detail, detailCapacity, key, valueUsage);
    }
    snprintf(detail, detailCapacity, "%s <%lu..%lu>", key, static_cast<unsigned long>(minimum),
             static_cast<unsigned long>(maximum));
    return SettingUpdate::InvalidValue;
  }
  if (number < minimum || number > maximum) {
    writeRangeDetail(detail, detailCapacity, key, minimum, maximum);
    return SettingUpdate::OutOfRange;
  }
  integer = static_cast<uint32_t>(number);
  return SettingUpdate::Accepted;
}

static SettingUpdate updateFrequency(RadioSettings &settings, const char *key, const char *value,
                                     char *detail, size_t detailCapacity) {
  float frequency = 0.0f;
  if (!parseDecimalFraction(value, frequency)) {
    return rejectValue(detail, detailCapacity, key, "<MHz>");
  }
  if (frequency < MINIMUM_FREQUENCY_MHZ || frequency > MAXIMUM_FREQUENCY_MHZ) {
    snprintf(detail, detailCapacity, "%s %.*f..%.*f", key, FREQUENCY_RANGE_DECIMALS,
             MINIMUM_FREQUENCY_MHZ, FREQUENCY_RANGE_DECIMALS, MAXIMUM_FREQUENCY_MHZ);
    return SettingUpdate::OutOfRange;
  }
  settings.frequencyMhz = frequency;
  return SettingUpdate::Accepted;
}

static SettingUpdate updateBandwidth(RadioSettings &settings, const char *key, const char *value,
                                     char *detail, size_t detailCapacity) {
  uint64_t number = 0;
  if (!parseUnsignedNumber(value, number)) {
    return rejectValue(detail, detailCapacity, key, "<kHz>");
  }
  for (const uint16_t bandwidth : BANDWIDTHS_KHZ) {
    if (number == bandwidth) {
      settings.bandwidthKhz = bandwidth;
      return SettingUpdate::Accepted;
    }
  }
  constexpr size_t count = sizeof(BANDWIDTHS_KHZ) / sizeof(BANDWIDTHS_KHZ[0]);
  size_t position = appendText(detail, detailCapacity, 0, "%s ", key);
  for (size_t index = 0; index < count; ++index) {
    position = appendText(detail, detailCapacity, position, "%s%u", listSeparator(index, count),
                          static_cast<unsigned>(BANDWIDTHS_KHZ[index]));
  }
  return SettingUpdate::OutOfRange;
}

// For an unreachable power, the detail lists the powers that the board model reaches:
// "power <minimum>..<maximum> or <additional> on <model>".
static SettingUpdate updateTransmitPower(RadioSettings &settings, const char *key,
                                         const char *value, BoardModel model, char *detail,
                                         size_t detailCapacity) {
  uint64_t number = 0;
  if (!parseUnsignedNumber(value, number)) {
    return rejectValue(detail, detailCapacity, key, "<dBm>");
  }
  if (number <= INT8_MAX && isTransmitPowerReachable(model, static_cast<int>(number))) {
    settings.transmitPowerDbm = static_cast<int8_t>(number);
    return SettingUpdate::Accepted;
  }
  const BoardModelDescription &description = describeBoardModel(model);
  size_t position =
      appendText(detail, detailCapacity, 0, "%s %d..%d", key, description.minimumTransmitPowerDbm,
                 description.maximumTransmitPowerDbm);
  for (uint8_t index = 0; index < description.additionalTransmitPowerCount; ++index) {
    position = appendText(detail, detailCapacity, position, " or %d",
                          description.additionalTransmitPowersDbm[index]);
  }
  appendText(detail, detailCapacity, position, " on %s", boardModelName(model));
  return SettingUpdate::UnreachablePower;
}

// "lna exists only on <models>", with every board model that has the LNA.
static SettingUpdate rejectLowNoiseAmplifier(char *detail, size_t detailCapacity, const char *key) {
  size_t count = 0;
  for (const BoardModelDescription &description : BOARD_MODEL_DESCRIPTIONS) {
    count += description.hasLowNoiseAmplifier ? 1 : 0;
  }
  size_t position = appendText(detail, detailCapacity, 0, "%s exists only on ", key);
  size_t index = 0;
  for (const BoardModelDescription &description : BOARD_MODEL_DESCRIPTIONS) {
    if (description.hasLowNoiseAmplifier) {
      position = appendText(detail, detailCapacity, position, "%s%s", listSeparator(index++, count),
                            boardModelName(description.model));
    }
  }
  return SettingUpdate::NotSupported;
}

static SettingUpdate updateLowNoiseAmplifier(RadioSettings &settings, const char *key,
                                             const char *value, BoardModel model, char *detail,
                                             size_t detailCapacity) {
  if (!hasLowNoiseAmplifier(model)) {
    return rejectLowNoiseAmplifier(detail, detailCapacity, key);
  }
  if (strcmp(value, lnaModeName(LnaMode::On)) == 0) {
    settings.lowNoiseAmplifierEnabled = true;
  } else if (strcmp(value, lnaModeName(LnaMode::Bypass)) == 0) {
    settings.lowNoiseAmplifierEnabled = false;
  } else {
    snprintf(detail, detailCapacity, "%s %s|%s", key, lnaModeName(LnaMode::On),
             lnaModeName(LnaMode::Bypass));
    return SettingUpdate::InvalidValue;
  }
  return SettingUpdate::Accepted;
}

SettingUpdate updateRadioSetting(RadioSettings &settings, const char *key, const char *value,
                                 BoardModel model, char *detail, size_t detailCapacity) {
  detail[0] = '\0';
  RadioSettingKey settingKey = RadioSettingKey::Freq;
  if (!findRadioSettingKey(key, settingKey)) {
    snprintf(detail, detailCapacity, "unknown key %s", key);
    return SettingUpdate::UnknownKey;
  }
  uint32_t integer = 0;
  SettingUpdate update = SettingUpdate::Accepted;
  switch (settingKey) {
  case RadioSettingKey::Freq:
    return updateFrequency(settings, key, value, detail, detailCapacity);
  case RadioSettingKey::Sf:
    update = readInteger(key, value, MINIMUM_SPREADING_FACTOR, MAXIMUM_SPREADING_FACTOR, nullptr,
                         integer, detail, detailCapacity);
    if (update == SettingUpdate::Accepted) {
      settings.spreadingFactor = static_cast<uint8_t>(integer);
    }
    return update;
  case RadioSettingKey::Bw:
    return updateBandwidth(settings, key, value, detail, detailCapacity);
  case RadioSettingKey::Cr:
    update = readInteger(key, value, MINIMUM_CODING_RATE_DENOMINATOR,
                         MAXIMUM_CODING_RATE_DENOMINATOR, nullptr, integer, detail, detailCapacity);
    if (update == SettingUpdate::Accepted) {
      settings.codingRateDenominator = static_cast<uint8_t>(integer);
    }
    return update;
  case RadioSettingKey::Preamble:
    update = readInteger(key, value, MINIMUM_PREAMBLE_LENGTH, MAXIMUM_PREAMBLE_LENGTH, "<symbols>",
                         integer, detail, detailCapacity);
    if (update == SettingUpdate::Accepted) {
      settings.preambleLength = static_cast<uint16_t>(integer);
    }
    return update;
  case RadioSettingKey::Sync:
    update = readInteger(key, value, MINIMUM_SYNC_WORD, MAXIMUM_SYNC_WORD, nullptr, integer, detail,
                         detailCapacity);
    if (update == SettingUpdate::Accepted) {
      settings.syncWord = static_cast<uint8_t>(integer);
    }
    return update;
  case RadioSettingKey::Power:
    return updateTransmitPower(settings, key, value, model, detail, detailCapacity);
  case RadioSettingKey::Lna:
    return updateLowNoiseAmplifier(settings, key, value, model, detail, detailCapacity);
  }
  return SettingUpdate::UnknownKey;
}

// ---------------------------------------------------------------------------------------------
// Handlers

void reportRadio(CommandInvocation &invocation) { invocation.node().reportRadio(); }

void resetRadio(CommandInvocation &invocation) {
  invocation.node().requestRadioSettings(defaultRadioSettings());
}

void changeRadio(CommandInvocation &invocation) {
  if (invocation.argumentCount() % 2 != 0) {
    invocation.rejectUsage();
    return;
  }
  CommandTarget &node = invocation.node();
  RadioSettings candidate = node.requestedRadioSettings();
  char detail[ERROR_DETAIL_CAPACITY];
  for (size_t index = 0; index + 1 < invocation.argumentCount(); index += 2) {
    const SettingUpdate update =
        updateRadioSetting(candidate, invocation.argument(index), invocation.argument(index + 1),
                           invocation.services().model(), detail, sizeof(detail));
    if (update != SettingUpdate::Accepted) {
      invocation.reject(settingUpdateReason(update), detail);
      return;
    }
  }
  node.requestRadioSettings(candidate);
}

} // namespace firmware
