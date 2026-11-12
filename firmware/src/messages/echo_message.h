#ifndef J5_ECHO_MESSAGE_H
#define J5_ECHO_MESSAGE_H

#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

// Bodies of ECHO_REQUEST and ECHO_REPLY (docs/protocol/frame.md). Their offsets are in the
// protocol contract. Both carry zeros after their fields, up to the length that the operator asked
// for: the reply has the length of the request, so both directions take the same time on air.

struct EchoRequestMessage {
  uint16_t number;
  uint16_t size; // body length, from ECHO_REPLY_FIELDS_SIZE to MAXIMUM_PAYLOAD_SIZE
};

struct EchoReplyMessage {
  uint16_t number;
  float rssi; // how the request arrived
  float snr;
  uint16_t size; // body length, that of the request
};

// Both write size bytes and return size.
size_t encodeEchoRequest(const EchoRequestMessage &message, uint8_t *output);
size_t encodeEchoReply(const EchoReplyMessage &message, uint8_t *output);

// A request shorter than the fields of the reply could not be answered with the same length, so
// both reject a body shorter than ECHO_REPLY_FIELDS_SIZE.
bool decodeEchoRequest(const uint8_t *payload, size_t length, EchoRequestMessage &message);
bool decodeEchoReply(const uint8_t *payload, size_t length, EchoReplyMessage &message);

} // namespace firmware

#endif
