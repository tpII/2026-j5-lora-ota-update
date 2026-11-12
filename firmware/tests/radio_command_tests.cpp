// Host tests of the radio settings and of the key/value pairs of the radio command.

#include <cstring>

#include "application/radio_command.h"
#include "host_test_harness.h"
#include "radio/radio_settings.h"

using namespace firmware;

static bool isSameSettings(const RadioSettings &first, const RadioSettings &second) {
  return first.frequencyMhz == second.frequencyMhz &&
         first.spreadingFactor == second.spreadingFactor &&
         first.bandwidthKhz == second.bandwidthKhz &&
         first.codingRateDenominator == second.codingRateDenominator &&
         first.preambleLength == second.preambleLength && first.syncWord == second.syncWord &&
         first.transmitPowerDbm == second.transmitPowerDbm &&
         first.lowNoiseAmplifierEnabled == second.lowNoiseAmplifierEnabled;
}

// Applies one key to the default settings and checks the outcome and the detail of the error.
static bool rejects(const char *key, const char *value, BoardModel model, SettingUpdate expected,
                    const char *detail) {
  RadioSettings settings = defaultRadioSettings();
  char text[ERROR_DETAIL_CAPACITY];
  const SettingUpdate update = updateRadioSetting(settings, key, value, model, text, sizeof(text));
  return update == expected && isSameSettings(settings, defaultRadioSettings()) &&
         std::strcmp(text, detail) == 0;
}

// Each default of the contract goes to its own field.
J5_HOST_TEST(testRadioSettingDefaults) {
  const RadioSettings settings = defaultRadioSettings();
  CHECK(settings.frequencyMhz == DEFAULT_FREQUENCY_MHZ);
  CHECK(settings.spreadingFactor == DEFAULT_SPREADING_FACTOR);
  CHECK(settings.bandwidthKhz == DEFAULT_BANDWIDTH_KHZ);
  CHECK(settings.codingRateDenominator == DEFAULT_CODING_RATE_DENOMINATOR);
  CHECK(settings.preambleLength == DEFAULT_PREAMBLE_LENGTH);
  CHECK(settings.syncWord == DEFAULT_SYNC_WORD);
  CHECK(settings.transmitPowerDbm == DEFAULT_TRANSMIT_POWER_DBM);
  CHECK(settings.lowNoiseAmplifierEnabled == (DEFAULT_LNA_MODE == LnaMode::On));
}

J5_HOST_TEST(testRadioSettingUpdates) {
  RadioSettings settings = defaultRadioSettings();
  char detail[ERROR_DETAIL_CAPACITY];
  CHECK(updateRadioSetting(settings, "freq", "927.75", BoardModel::HeltecV2, detail,
                           sizeof(detail)) == SettingUpdate::Accepted);
  CHECK(updateRadioSetting(settings, "sf", "12", BoardModel::HeltecV2, detail, sizeof(detail)) ==
        SettingUpdate::Accepted);
  CHECK(updateRadioSetting(settings, "bw", "125", BoardModel::HeltecV2, detail, sizeof(detail)) ==
        SettingUpdate::Accepted);
  CHECK(updateRadioSetting(settings, "cr", "8", BoardModel::HeltecV2, detail, sizeof(detail)) ==
        SettingUpdate::Accepted);
  CHECK(updateRadioSetting(settings, "preamble", "65535", BoardModel::HeltecV2, detail,
                           sizeof(detail)) == SettingUpdate::Accepted);
  CHECK(updateRadioSetting(settings, "sync", "0x34", BoardModel::HeltecV2, detail,
                           sizeof(detail)) == SettingUpdate::Accepted);
  CHECK(updateRadioSetting(settings, "power", "20", BoardModel::HeltecV2, detail, sizeof(detail)) ==
        SettingUpdate::Accepted);
  CHECK(updateRadioSetting(settings, "lna", "on", BoardModel::HeltecV43, detail, sizeof(detail)) ==
        SettingUpdate::Accepted);
  CHECK(settings.frequencyMhz == 927.75f && settings.spreadingFactor == 12);
  CHECK(settings.bandwidthKhz == 125 && settings.codingRateDenominator == 8);
  CHECK(settings.preambleLength == 65535 && settings.syncWord == 0x34);
  CHECK(settings.transmitPowerDbm == 20 && settings.lowNoiseAmplifierEnabled);
  CHECK(detail[0] == '\0');
}

J5_HOST_TEST(testRadioSettingNumbers) {
  // Decimal, where a leading zero changes nothing, or hexadecimal with 0x; freq takes a decimal
  // fraction.
  RadioSettings settings = defaultRadioSettings();
  char detail[ERROR_DETAIL_CAPACITY];
  const BoardModel v2 = BoardModel::HeltecV2;
  CHECK(updateRadioSetting(settings, "preamble", "010", v2, detail, sizeof(detail)) ==
        SettingUpdate::Accepted);
  CHECK(updateRadioSetting(settings, "sf", "0x9", v2, detail, sizeof(detail)) ==
        SettingUpdate::Accepted);
  CHECK(updateRadioSetting(settings, "bw", "0X0FA", v2, detail, sizeof(detail)) ==
        SettingUpdate::Accepted);
  CHECK(updateRadioSetting(settings, "freq", "923", v2, detail, sizeof(detail)) ==
        SettingUpdate::Accepted);
  CHECK(settings.preambleLength == 10 && settings.spreadingFactor == 9);
  CHECK(settings.bandwidthKhz == 250 && settings.frequencyMhz == 923.0f);
}

J5_HOST_TEST(testRadioSettingRejections) {
  const BoardModel v2 = BoardModel::HeltecV2;
  const BoardModel v43 = BoardModel::HeltecV43;
  // The detail texts of the error event.
  CHECK(rejects("freq", "abc", v2, SettingUpdate::InvalidValue, "freq <MHz>"));
  CHECK(rejects("freq", "914.9", v2, SettingUpdate::OutOfRange, "freq 915.0..928.0"));
  CHECK(rejects("sf", "x", v2, SettingUpdate::InvalidValue, "sf <7..12>"));
  CHECK(rejects("sf", "13", v2, SettingUpdate::OutOfRange, "sf 7..12"));
  CHECK(rejects("bw", "", v2, SettingUpdate::InvalidValue, "bw <kHz>"));
  CHECK(rejects("bw", "200", v2, SettingUpdate::OutOfRange, "bw 125, 250 or 500"));
  CHECK(rejects("cr", "4/5", v2, SettingUpdate::InvalidValue, "cr <5..8>"));
  CHECK(rejects("cr", "4", v2, SettingUpdate::OutOfRange, "cr 5..8"));
  CHECK(rejects("preamble", "many", v2, SettingUpdate::InvalidValue, "preamble <symbols>"));
  CHECK(rejects("preamble", "5", v2, SettingUpdate::OutOfRange, "preamble 6..65535"));
  CHECK(rejects("sync", "-", v2, SettingUpdate::InvalidValue, "sync <0..255>"));
  CHECK(rejects("sync", "256", v2, SettingUpdate::OutOfRange, "sync 0..255"));
  CHECK(rejects("power", "high", v2, SettingUpdate::InvalidValue, "power <dBm>"));
  CHECK(rejects("power", "18", v2, SettingUpdate::UnreachablePower, "power 2..17 or 20 on V2"));
  CHECK(rejects("power", "3", v43, SettingUpdate::UnreachablePower, "power 4..28 on V4.3"));
  CHECK(rejects("power", "300", v43, SettingUpdate::UnreachablePower, "power 4..28 on V4.3"));
  CHECK(rejects("lna", "on", v2, SettingUpdate::NotSupported, "lna exists only on V4.3"));
  CHECK(rejects("lna", "off", v43, SettingUpdate::InvalidValue, "lna on|bypass"));
  CHECK(rejects("gain", "3", v2, SettingUpdate::UnknownKey, "unknown key gain"));

  // The values follow the number grammar of every command: no sign, no octal, no exponent and
  // nothing that strtof would take for a number.
  CHECK(rejects("sf", "-7", v2, SettingUpdate::InvalidValue, "sf <7..12>"));
  CHECK(rejects("sf", "+7", v2, SettingUpdate::InvalidValue, "sf <7..12>"));
  CHECK(rejects("power", "-3", v43, SettingUpdate::InvalidValue, "power <dBm>"));
  CHECK(rejects("sync", "0x", v2, SettingUpdate::InvalidValue, "sync <0..255>"));
  CHECK(rejects("sync", "0x100", v2, SettingUpdate::OutOfRange, "sync 0..255"));
  CHECK(rejects("freq", "nan", v2, SettingUpdate::InvalidValue, "freq <MHz>"));
  CHECK(rejects("freq", "inf", v2, SettingUpdate::InvalidValue, "freq <MHz>"));
  CHECK(rejects("freq", "9.159e2", v2, SettingUpdate::InvalidValue, "freq <MHz>"));
  CHECK(rejects("freq", "915.", v2, SettingUpdate::InvalidValue, "freq <MHz>"));
  CHECK(rejects("freq", "-915.9", v2, SettingUpdate::InvalidValue, "freq <MHz>"));
  CHECK(rejects("freq", "0x392", v2, SettingUpdate::InvalidValue, "freq <MHz>"));
}
