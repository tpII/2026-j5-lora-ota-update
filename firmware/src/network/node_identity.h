#ifndef J5_NODE_IDENTITY_H
#define J5_NODE_IDENTITY_H

#include <stdint.h>

namespace j5 {

// Node identifier, epoch and sequence numbers (docs/protocol/frame.md).
class NodeIdentity {
public:
  // Derives the identifier from the factory MAC and advances the epoch kept in NVS.
  void begin();

  uint16_t nodeId() const { return nodeId_; }
  uint8_t epoch() const { return epoch_; }

  // Assigns epoch and sequence to a new frame. When the sequence wraps around, the epoch
  // advances and the sequence starts again at 0.
  void assignSequence(uint8_t &epoch, uint16_t &sequence);

private:
  void advanceEpoch();

  uint16_t nodeId_ = 0;
  uint8_t epoch_ = 0;
  uint16_t nextSequence_ = 0;
};

} // namespace j5

#endif
