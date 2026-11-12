#include "frame.h"

#include <sodium.h>
#include <string.h>

#include "../configuration.h"
#include "../encoding/byte_order.h"

namespace firmware {

// HMAC-SHA256 over the protocol version followed by header and payload. The version byte does
// not travel in the frame, so a frame built for another protocol version fails verification
// (docs/adrs/0005-frame-without-hop-count.md).
static void computeTag(const uint8_t *data, size_t length, uint8_t *tag) {
  static const uint8_t version = PROTOCOL_VERSION;
  static const char *key = J5_NETWORK_KEY;
  uint8_t digest[crypto_auth_hmacsha256_BYTES];

  crypto_auth_hmacsha256_state state;
  crypto_auth_hmacsha256_init(&state, reinterpret_cast<const unsigned char *>(key), strlen(key));
  crypto_auth_hmacsha256_update(&state, &version, 1);
  crypto_auth_hmacsha256_update(&state, data, length);
  crypto_auth_hmacsha256_final(&state, digest);

  memcpy(tag, digest, FRAME_TAG_SIZE);
}

static void writeHeader(const FrameHeader &header, uint8_t *output) {
  output[FRAME_TYPE_OFFSET] = header.type;
  writeUint16(output + FRAME_SOURCE_OFFSET, header.source);
  writeUint16(output + FRAME_DESTINATION_OFFSET, header.destination);
  output[FRAME_EPOCH_OFFSET] = header.epoch;
  writeUint16(output + FRAME_SEQUENCE_OFFSET, header.sequence);
}

size_t encodeFrame(const FrameHeader &header, const uint8_t *payload, size_t payloadLength,
                   uint8_t *output) {
  if (payloadLength > MAXIMUM_PAYLOAD_SIZE) {
    return 0;
  }
  writeHeader(header, output);
  if (payloadLength > 0) {
    memcpy(output + FRAME_HEADER_SIZE, payload, payloadLength);
  }
  const size_t authenticatedLength = FRAME_HEADER_SIZE + payloadLength;
  computeTag(output, authenticatedLength, output + authenticatedLength);
  return authenticatedLength + FRAME_TAG_SIZE;
}

static void readHeader(const uint8_t *data, FrameHeader &header) {
  header.type = data[FRAME_TYPE_OFFSET];
  header.source = readUint16(data + FRAME_SOURCE_OFFSET);
  header.destination = readUint16(data + FRAME_DESTINATION_OFFSET);
  header.epoch = data[FRAME_EPOCH_OFFSET];
  header.sequence = readUint16(data + FRAME_SEQUENCE_OFFSET);
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

  readHeader(data, header);
  payload = data + FRAME_HEADER_SIZE;
  payloadLength = authenticatedLength - FRAME_HEADER_SIZE;
  return FrameCheck::Valid;
}

} // namespace firmware
