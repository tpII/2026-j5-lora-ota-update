#include "message_body.h"

namespace firmware {

static bool decodeKnownBody(MessageType type, const uint8_t *payload, size_t length,
                            MessageBody &body) {
  switch (type) {
  case MessageType::Hello:
    return decodeHello(payload, length, body.hello);
  case MessageType::EchoRequest:
    return decodeEchoRequest(payload, length, body.echoRequest);
  case MessageType::EchoReply:
    return decodeEchoReply(payload, length, body.echoReply);
  case MessageType::Test:
    return decodeTest(payload, length, body.test);
  case MessageType::Fragment:
    return decodeFragment(payload, length, body.fragment);
  case MessageType::Report:
    return decodeReport(payload, length, body.report);
  }
  return false;
}

BodyCheck decodeMessageBody(uint8_t type, const uint8_t *payload, size_t length,
                            MessageBody &body) {
  if (!isKnownMessageType(type)) {
    return BodyCheck::UnknownType;
  }
  body.type = static_cast<MessageType>(type);
  return decodeKnownBody(body.type, payload, length, body) ? BodyCheck::Valid : BodyCheck::Invalid;
}

} // namespace firmware
