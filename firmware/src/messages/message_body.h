#ifndef J5_MESSAGE_BODY_H
#define J5_MESSAGE_BODY_H

#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"
#include "echo_message.h"
#include "fragment_message.h"
#include "hello_message.h"
#include "report_message.h"
#include "test_message.h"

namespace firmware {

enum class BodyCheck : uint8_t { Valid, UnknownType, Invalid };

// The decoded body of a received frame. type tells which member holds it.
struct MessageBody {
  MessageType type;
  union {
    HelloMessage hello;
    EchoRequestMessage echoRequest;
    EchoReplyMessage echoReply;
    TestMessage test;
    FragmentMessage fragment; // its data points into the payload
    ReportMessage report;
  };
};

BodyCheck decodeMessageBody(uint8_t type, const uint8_t *payload, size_t length, MessageBody &body);

} // namespace firmware

#endif
