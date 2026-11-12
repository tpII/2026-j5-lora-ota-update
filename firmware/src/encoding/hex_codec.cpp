#include "hex_codec.h"

#include <string.h>

namespace firmware {

int hexadecimalDigitValue(char digit) {
  if (digit >= '0' && digit <= '9') {
    return digit - '0';
  }
  if (digit >= 'a' && digit <= 'f') {
    return digit - 'a' + 10;
  }
  if (digit >= 'A' && digit <= 'F') {
    return digit - 'A' + 10;
  }
  return -1;
}

bool decodeHexBytes(const char *text, uint8_t *output, size_t capacity, size_t &length) {
  const size_t digits = strlen(text);
  if (digits % 2 != 0 || digits / 2 > capacity) {
    return false;
  }
  for (size_t index = 0; index < digits / 2; ++index) {
    const int high = hexadecimalDigitValue(text[2 * index]);
    const int low = hexadecimalDigitValue(text[2 * index + 1]);
    if (high < 0 || low < 0) {
      return false;
    }
    output[index] = static_cast<uint8_t>((high << 4) | low);
  }
  length = digits / 2;
  return true;
}

void encodeHexBytes(const uint8_t *bytes, size_t length, char *output) {
  static const char DIGITS[] = "0123456789abcdef";
  for (size_t index = 0; index < length; ++index) {
    output[2 * index] = DIGITS[bytes[index] >> 4];
    output[2 * index + 1] = DIGITS[bytes[index] & 0x0F];
  }
}

} // namespace firmware
