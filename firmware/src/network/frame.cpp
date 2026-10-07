#include "frame.h"

#include <mbedtls/md.h>
#include <string.h>

#include "../configuration.h"
#include "byte_order.h"

namespace j5 {

namespace {

constexpr size_t SHA256_DIGEST_SIZE = 32;

// HMAC-SHA256 over the protocol version followed by header and payload. The version byte does
// not travel in the frame, so a frame built for another protocol version fails verification
// (docs/adrs/0005-frame-without-hop-count.md).
void computeTag(const uint8_t *data, size_t length, uint8_t *tag) {
  static const uint8_t version = PROTOCOL_VERSION;
  static const char *key = J5_NETWORK_KEY;
  uint8_t digest[SHA256_DIGEST_SIZE];

  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  mbedtls_md_setup(&context, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&context, reinterpret_cast<const unsigned char *>(key), strlen(key));
  mbedtls_md_hmac_update(&context, &version, 1);
  mbedtls_md_hmac_update(&context, data, length);
  mbedtls_md_hmac_finish(&context, digest);
  mbedtls_md_free(&context);

  memcpy(tag, digest, FRAME_TAG_SIZE);
}

void writeHeader(const FrameHeader &header, uint8_t *output) {
  output[0] = header.type;
  writeUint16(output + 1, header.source);
  writeUint16(output + 3, header.destination);
  output[5] = header.epoch;
  writeUint16(output + 6, header.sequence);
}

} // namespace

bool isKnownMessageType(uint8_t type) {
  switch (static_cast<MessageType>(type)) {
  case MessageType::Hello:
  case MessageType::EchoRequest:
  case MessageType::EchoReply:
  case MessageType::Test:
    return true;
  }
  return false;
}

const char *messageTypeName(uint8_t type) {
  switch (static_cast<MessageType>(type)) {
  case MessageType::Hello:
    return "hello";
  case MessageType::EchoRequest:
    return "echo_request";
  case MessageType::EchoReply:
    return "echo_reply";
  case MessageType::Test:
    return "test";
  }
  return "unknown";
}

size_t encodeFrame(const FrameHeader &header, const uint8_t *payload, size_t payloadLength,
                   uint8_t *output) {
  if (payloadLength > MAXIMUM_PAYLOAD_SIZE) {
    payloadLength = MAXIMUM_PAYLOAD_SIZE;
  }
  writeHeader(header, output);
  if (payloadLength > 0) {
    memcpy(output + FRAME_HEADER_SIZE, payload, payloadLength);
  }
  const size_t authenticatedLength = FRAME_HEADER_SIZE + payloadLength;
  computeTag(output, authenticatedLength, output + authenticatedLength);
  return authenticatedLength + FRAME_TAG_SIZE;
}

bool readFrameHeader(const uint8_t *data, size_t length, FrameHeader &header) {
  if (length < FRAME_HEADER_SIZE) {
    return false;
  }
  header.type = data[0];
  header.source = readUint16(data + 1);
  header.destination = readUint16(data + 3);
  header.epoch = data[5];
  header.sequence = readUint16(data + 6);
  return true;
}

FrameCheck decodeFrame(const uint8_t *data, size_t length, FrameHeader &header,
                       const uint8_t *&payload, size_t &payloadLength) {
  if (length < FRAME_OVERHEAD) {
    return FrameCheck::TooShort;
  }
  const size_t authenticatedLength = length - FRAME_TAG_SIZE;
  uint8_t expectedTag[FRAME_TAG_SIZE];
  computeTag(data, authenticatedLength, expectedTag);

  // Compare every byte so the time taken does not depend on where the tags differ.
  uint8_t difference = 0;
  for (size_t index = 0; index < FRAME_TAG_SIZE; ++index) {
    difference |= expectedTag[index] ^ data[authenticatedLength + index];
  }
  if (difference != 0) {
    return FrameCheck::InvalidTag;
  }

  readFrameHeader(data, length, header);
  payload = data + FRAME_HEADER_SIZE;
  payloadLength = authenticatedLength - FRAME_HEADER_SIZE;
  return FrameCheck::Valid;
}

} // namespace j5
