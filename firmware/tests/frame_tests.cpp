// Host tests of the frame codec: the header layout, the authentication tag of the shared vector,
// the protocol version inside the tag and the length rules (docs/protocol/frame.md).

#include <cstring>
#include <sodium.h>
#include <vector>

#include "configuration.h"
#include "encoding/hex_codec.h"
#include "generated_test_vectors.h"
#include "host_test_harness.h"
#include "network/frame.h"

using namespace firmware;

static std::vector<uint8_t> bytesOf(const char *hexadecimal) {
  std::vector<uint8_t> bytes(std::strlen(hexadecimal) / 2);
  size_t length = 0;
  CHECK(decodeHexBytes(hexadecimal, bytes.data(), bytes.size(), length) && length == bytes.size());
  return bytes;
}

J5_HOST_TEST(testFrameVectors) {
  // The vector is authenticated with the default network key, which the host tests build with.
  CHECK(J5_NETWORK_KEY_IS_DEFAULT && std::strcmp(J5_NETWORK_KEY, FRAME_VECTOR_NETWORK_KEY) == 0);
  for (const FrameVector &vector : FRAME_VECTORS) {
    const FrameHeader header{vector.type, vector.source, vector.destination, vector.epoch,
                             vector.sequence};
    const std::vector<uint8_t> body = bytesOf(vector.body);
    const std::vector<uint8_t> expected = bytesOf(vector.frame);
    uint8_t frame[MAXIMUM_FRAME_SIZE];
    const size_t length = encodeFrame(header, body.data(), body.size(), frame);
    CHECK(length == expected.size() && std::memcmp(frame, expected.data(), length) == 0);

    FrameHeader decoded{};
    const uint8_t *payload = nullptr;
    size_t payloadLength = 0;
    CHECK(decodeFrame(expected.data(), expected.size(), decoded, payload, payloadLength) ==
          FrameCheck::Valid);
    CHECK(decoded.type == header.type && decoded.source == header.source);
    CHECK(decoded.destination == header.destination && decoded.epoch == header.epoch);
    CHECK(decoded.sequence == header.sequence && payloadLength == body.size());
    CHECK(payload == expected.data() + FRAME_HEADER_SIZE);
    CHECK(payloadLength == 0 || std::memcmp(payload, body.data(), payloadLength) == 0);
  }
}

J5_HOST_TEST(testFrameChecks) {
  const FrameVector &vector = FRAME_VECTORS[0];
  const std::vector<uint8_t> frame = bytesOf(vector.frame);
  FrameHeader header{};
  const uint8_t *payload = nullptr;
  size_t payloadLength = 0;

  // Every byte enters the tag: the header, the body and the tag itself.
  for (size_t index = 0; index < frame.size(); ++index) {
    std::vector<uint8_t> altered = frame;
    altered[index] ^= 0x01;
    CHECK(decodeFrame(altered.data(), altered.size(), header, payload, payloadLength) ==
          FrameCheck::InvalidTag);
  }
  CHECK(decodeFrame(frame.data(), FRAME_OVERHEAD - 1, header, payload, payloadLength) ==
        FrameCheck::TooShort);
  CHECK(decodeFrame(frame.data(), frame.size() - 1, header, payload, payloadLength) ==
        FrameCheck::InvalidTag);

  // The protocol version enters the tag without travelling: a frame of another version fails.
  const size_t authenticatedLength = frame.size() - FRAME_TAG_SIZE;
  const uint8_t otherVersion = PROTOCOL_VERSION + 1;
  uint8_t digest[crypto_auth_hmacsha256_BYTES];
  crypto_auth_hmacsha256_state state;
  crypto_auth_hmacsha256_init(&state, reinterpret_cast<const unsigned char *>(J5_NETWORK_KEY),
                              std::strlen(J5_NETWORK_KEY));
  crypto_auth_hmacsha256_update(&state, &otherVersion, 1);
  crypto_auth_hmacsha256_update(&state, frame.data(), authenticatedLength);
  crypto_auth_hmacsha256_final(&state, digest);
  std::vector<uint8_t> otherFrame = frame;
  std::memcpy(otherFrame.data() + authenticatedLength, digest, FRAME_TAG_SIZE);
  CHECK(decodeFrame(otherFrame.data(), otherFrame.size(), header, payload, payloadLength) ==
        FrameCheck::InvalidTag);

  // The longest body fills a frame; a longer one is not encoded.
  uint8_t body[MAXIMUM_PAYLOAD_SIZE + 1] = {};
  uint8_t output[MAXIMUM_FRAME_SIZE];
  const FrameHeader own{vector.type, vector.source, vector.destination, vector.epoch,
                        vector.sequence};
  CHECK(encodeFrame(own, body, MAXIMUM_PAYLOAD_SIZE, output) == MAXIMUM_FRAME_SIZE);
  CHECK(decodeFrame(output, MAXIMUM_FRAME_SIZE, header, payload, payloadLength) ==
        FrameCheck::Valid);
  CHECK(payloadLength == MAXIMUM_PAYLOAD_SIZE);
  CHECK(encodeFrame(own, body, MAXIMUM_PAYLOAD_SIZE + 1, output) == 0);
}
