#ifndef J5_FRAME_H
#define J5_FRAME_H

#include <stddef.h>
#include <stdint.h>

namespace firmware {

// LoRa frame, protocol version 1 (docs/protocol/frame.md).

constexpr size_t FRAME_HEADER_SIZE = 8;
constexpr size_t FRAME_TAG_SIZE = 8;
constexpr size_t FRAME_OVERHEAD = FRAME_HEADER_SIZE + FRAME_TAG_SIZE;
constexpr size_t MAXIMUM_FRAME_SIZE = 255;
constexpr size_t MAXIMUM_PAYLOAD_SIZE = MAXIMUM_FRAME_SIZE - FRAME_OVERHEAD;

constexpr uint16_t BROADCAST_NODE_ID = 0xFFFF;

enum class MessageType : uint8_t {
  Hello = 0x01,
  EchoRequest = 0x02,
  EchoReply = 0x03,
  Test = 0x10,
};

bool isKnownMessageType(uint8_t type);

// Name used in console events ("hello", "echo_request", "echo_reply", "test").
const char *messageTypeName(uint8_t type);

struct FrameHeader {
  uint8_t type;
  uint16_t source;
  uint16_t destination;
  uint8_t epoch;
  uint16_t sequence;
};

enum class FrameCheck : uint8_t { Valid, TooShort, InvalidTag };

// Writes header, payload and authentication tag to output, which must hold MAXIMUM_FRAME_SIZE
// bytes. Returns the frame length.
size_t encodeFrame(const FrameHeader &header, const uint8_t *payload, size_t payloadLength,
                   uint8_t *output);

// Verifies the tag and splits the frame. The payload pointer refers to data.
FrameCheck decodeFrame(const uint8_t *data, size_t length, FrameHeader &header,
                       const uint8_t *&payload, size_t &payloadLength);

// Reads only the header fields, without verifying the tag.
bool readFrameHeader(const uint8_t *data, size_t length, FrameHeader &header);

} // namespace firmware

#endif
