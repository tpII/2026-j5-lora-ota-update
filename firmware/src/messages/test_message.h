#ifndef J5_TEST_MESSAGE_H
#define J5_TEST_MESSAGE_H

#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

// Body of a TEST (docs/protocol/frame.md): the fields of the run, then zeros up to the length of
// the run. Its sizes and offsets are in the protocol contract.
struct TestMessage {
  uint16_t run;
  uint16_t index;
  uint16_t count;
  uint16_t interval;
  uint16_t size; // body length, from TEST_FIELDS_SIZE to MAXIMUM_PAYLOAD_SIZE
};

// Writes size bytes and returns size.
size_t encodeTest(const TestMessage &message, uint8_t *output);
// False for a body shorter than its fields, a count of 0 or an index outside the count.
bool decodeTest(const uint8_t *payload, size_t length, TestMessage &message);

} // namespace firmware

#endif
