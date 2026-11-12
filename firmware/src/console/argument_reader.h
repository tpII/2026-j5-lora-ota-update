#ifndef J5_ARGUMENT_READER_H
#define J5_ARGUMENT_READER_H

#include <stddef.h>
#include <stdint.h>

namespace firmware {

// The words of a console command read as values (docs/protocol/console.md, "Comandos"). Every
// command reads its numbers with this grammar: no sign, decimal digits or 0x (or 0X) followed by
// hexadecimal digits in either case. A leading zero does not make a number octal.

// An unsigned number. Returns false for any other word. A value above UINT32_MAX comes out as
// UINT32_MAX + 1, so that the caller still reports it out of range.
bool parseUnsignedNumber(const char *text, uint64_t &value);

// A register value: an unsigned number, or one with a minus sign before it, from INT32_MIN to
// UINT32_MAX. Values above INT32_MAX keep their bit pattern, so 0xFFFFFFFF and -1 give the same
// register contents.
bool parseRegisterValue(const char *text, int32_t &value);

// A node identifier: one to NODE_ID_HEXADECIMAL_DIGITS hexadecimal digits in either case, without
// 0x, as the console writes identifiers.
bool parseNodeIdentifier(const char *text, uint16_t &id);

// A decimal fraction, such as 915.9: decimal digits, optionally followed by a point and more
// decimal digits.
bool parseDecimalFraction(const char *text, float &value);

// The detail of out_of_range for a value outside a range: "<name> <minimum>..<maximum>".
void writeRangeDetail(char *detail, size_t detailCapacity, const char *name, uint32_t minimum,
                      uint32_t maximum);

} // namespace firmware

#endif
