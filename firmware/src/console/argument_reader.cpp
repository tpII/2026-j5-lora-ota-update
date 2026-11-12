#include "argument_reader.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../encoding/hex_codec.h"
#include "../protocol/protocol_contract.h"

namespace firmware {

static constexpr uint64_t SATURATED_VALUE = static_cast<uint64_t>(UINT32_MAX) + 1;

static bool parseDigits(const char *text, unsigned base, uint64_t &value) {
  if (*text == '\0') {
    return false;
  }
  value = 0;
  for (; *text != '\0'; ++text) {
    const int digit = hexadecimalDigitValue(*text);
    if (digit < 0 || static_cast<unsigned>(digit) >= base) {
      return false;
    }
    value = value * base + static_cast<unsigned>(digit);
    if (value > UINT32_MAX) {
      value = SATURATED_VALUE;
    }
  }
  return true;
}

static bool isDecimalDigit(char character) { return character >= '0' && character <= '9'; }

bool parseUnsignedNumber(const char *text, uint64_t &value) {
  const bool hexadecimal = text[0] == '0' && (text[1] == 'x' || text[1] == 'X');
  return hexadecimal ? parseDigits(text + 2, 16, value) : parseDigits(text, 10, value);
}

bool parseRegisterValue(const char *text, int32_t &value) {
  const bool negative = *text == '-';
  uint64_t magnitude = 0;
  if (!parseUnsignedNumber(negative ? text + 1 : text, magnitude)) {
    return false;
  }
  if (negative) {
    if (magnitude > static_cast<uint64_t>(INT32_MAX) + 1) {
      return false;
    }
    value = static_cast<int32_t>(static_cast<uint32_t>(0U - static_cast<uint32_t>(magnitude)));
    return true;
  }
  if (magnitude > UINT32_MAX) {
    return false;
  }
  value = static_cast<int32_t>(static_cast<uint32_t>(magnitude));
  return true;
}

bool parseNodeIdentifier(const char *text, uint16_t &id) {
  uint64_t value = 0;
  if (strlen(text) > NODE_ID_HEXADECIMAL_DIGITS || !parseDigits(text, 16, value)) {
    return false;
  }
  id = static_cast<uint16_t>(value);
  return true;
}

bool parseDecimalFraction(const char *text, float &value) {
  const char *character = text;
  while (isDecimalDigit(*character)) {
    ++character;
  }
  if (character == text) {
    return false;
  }
  if (*character == '.') {
    const char *fraction = ++character;
    while (isDecimalDigit(*character)) {
      ++character;
    }
    if (character == fraction) {
      return false;
    }
  }
  if (*character != '\0') {
    return false;
  }
  value = strtof(text, nullptr);
  return true;
}

void writeRangeDetail(char *detail, size_t detailCapacity, const char *name, uint32_t minimum,
                      uint32_t maximum) {
  snprintf(detail, detailCapacity, "%s %lu..%lu", name, static_cast<unsigned long>(minimum),
           static_cast<unsigned long>(maximum));
}

} // namespace firmware
