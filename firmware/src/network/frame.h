#ifndef J5_FRAME_H
#define J5_FRAME_H

#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

// LoRa frame (docs/protocol/frame.md). Its sizes, offsets and message types are in the protocol
// contract.

struct FrameHeader {
  uint8_t type;
  uint16_t source;
  uint16_t destination;
  uint8_t epoch;
  uint16_t sequence;
};

enum class FrameCheck : uint8_t { Valid, TooShort, InvalidTag };

// Gives every new frame of the node its epoch and sequence, which identify it together with the
// source (docs/protocol/frame.md).
class SequenceSource {
public:
  virtual void assignSequence(uint8_t &epoch, uint16_t &sequence) = 0;

protected:
  ~SequenceSource() = default;
};

// Writes header, payload and authentication tag to output, which must hold MAXIMUM_FRAME_SIZE
// bytes. Returns the frame length, or 0 without writing anything for a payload longer than
// MAXIMUM_PAYLOAD_SIZE.
size_t encodeFrame(const FrameHeader &header, const uint8_t *payload, size_t payloadLength,
                   uint8_t *output);

// Verifies the tag and splits the frame. The payload pointer refers to data.
FrameCheck decodeFrame(const uint8_t *data, size_t length, FrameHeader &header,
                       const uint8_t *&payload, size_t &payloadLength);

} // namespace firmware

#endif
