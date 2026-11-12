// Host tests of the hexadecimal codec.

#include <cstring>

#include "encoding/hex_codec.h"
#include "host_test_harness.h"

using namespace firmware;

J5_HOST_TEST(testHexCodec) {
  uint8_t code[8] = {};
  size_t length = 0;
  CHECK(!decodeHexBytes("abc", code, sizeof(code), length));
  CHECK(!decodeHexBytes("zz", code, sizeof(code), length));
  CHECK(!decodeHexBytes("000000000000000000", code, sizeof(code), length));
  CHECK(decodeHexBytes("0aFF", code, sizeof(code), length) && length == 2 && code[1] == 0xFF);
  char text[5] = {};
  encodeHexBytes(code, length, text);
  CHECK(std::strcmp(text, "0aff") == 0);
}
