#ifndef J5_HEX_CODEC_H
#define J5_HEX_CODEC_H

#include <stddef.h>
#include <stdint.h>

namespace firmware {

// Bytes written as two hexadecimal digits each, high nibble first: the images of load_image, the
// operator public key and the program event.

// The value of a hexadecimal digit in either case, or -1 for any other character.
int hexadecimalDigitValue(char digit);

// Decodes an even number of hexadecimal digits, in either case. Returns false on any other
// character, an odd count or more bytes than the capacity.
bool decodeHexBytes(const char *text, uint8_t *output, size_t capacity, size_t &length);

// Writes 2 * length lowercase digits to output, without a terminating null.
void encodeHexBytes(const uint8_t *bytes, size_t length, char *output);

} // namespace firmware

#endif
