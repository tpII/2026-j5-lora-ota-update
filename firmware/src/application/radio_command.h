#ifndef J5_RADIO_COMMAND_H
#define J5_RADIO_COMMAND_H

#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"
#include "../radio/radio_settings.h"
#include "console_commands.h"

namespace firmware {

// The radio command (docs/protocol/console.md): its handlers and the reading of each key/value
// pair, with the details of its errors. Its usage, with the keys of the contract, is in the table
// of commands (CONSOLE_COMMANDS).

// How a key/value pair of the radio command went; every outcome but Accepted is an error.
enum class SettingUpdate : uint8_t {
  Accepted,
  UnknownKey,
  InvalidValue,
  OutOfRange,
  UnreachablePower,
  NotSupported
};

// Applies one key/value pair of the radio command to the settings of a board of the model. The
// integer values are numbers as every command reads them (console/argument_reader.h) and freq a
// decimal fraction. On failure the settings are left untouched and the detail buffer describes
// the accepted values: for a value that is no number, the usage of the key, such as
// "sf <minimum..maximum>".
SettingUpdate updateRadioSetting(RadioSettings &settings, const char *key, const char *value,
                                 BoardModel model, char *detail, size_t detailCapacity);

// Reason of the console error event for a failed update; radio_command.cpp checks that the
// failures give exactly the reasons of SETTING_UPDATE_REASONS.
constexpr ErrorReason settingUpdateReason(SettingUpdate update) {
  switch (update) {
  case SettingUpdate::Accepted:
  case SettingUpdate::UnknownKey:
  case SettingUpdate::InvalidValue:
    return ErrorReason::Usage;
  case SettingUpdate::OutOfRange:
    return ErrorReason::OutOfRange;
  case SettingUpdate::UnreachablePower:
    return ErrorReason::UnreachablePower;
  case SettingUpdate::NotSupported:
    return ErrorReason::NotSupported;
  }
  return ErrorReason::Usage;
}

// The forms of radio: without arguments it reports the settings, with reset it goes back to the
// defaults, and with key/value pairs it checks every pair on a copy before it applies any, so one
// invalid pair changes nothing.
void reportRadio(CommandInvocation &invocation);
void resetRadio(CommandInvocation &invocation);
void changeRadio(CommandInvocation &invocation);

} // namespace firmware

#endif
