#ifndef J5_HELLO_MESSAGE_H
#define J5_HELLO_MESSAGE_H

#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

// The state that a node announces in its HELLO, decoded.
struct AnnouncedState {
  bool modelKnown; // false for a model code outside the contract, or before the first HELLO
  BoardModel model;
  VmFault lastFault;  // None as well for a fault code outside the contract
  bool vmFailing;     // the program faulted since the previous HELLO
  uint32_t version;   // active version
  uint32_t available; // available version
  uint32_t transmitted;
};

// How the sender of a HELLO hears one of its neighbors, with the resolution of the body.
struct HelloNeighborEntry {
  uint16_t id;
  int16_t rssi;
  float snr;
};

// Body of a HELLO (docs/protocol/frame.md). Its sizes and offsets are in the protocol contract.
struct HelloMessage {
  AnnouncedState announced;
  uint8_t neighborCount;
  HelloNeighborEntry neighbors[MAXIMUM_NEIGHBORS];
};

// Writes the code of announced.model, the state of the VM as the byte vm and at most
// MAXIMUM_NEIGHBORS neighbors. Returns the body length.
size_t encodeHello(const HelloMessage &message, uint8_t *output);
// False when the body is shorter than its fixed part, lists more than MAXIMUM_NEIGHBORS neighbors
// or has a length that does not match its neighbor count.
bool decodeHello(const uint8_t *payload, size_t length, HelloMessage &message);

} // namespace firmware

#endif
