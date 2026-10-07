#ifndef J5_NEIGHBOR_TABLE_H
#define J5_NEIGHBOR_TABLE_H

#include <stddef.h>
#include <stdint.h>

#include "../configuration.h"

namespace j5 {

struct Neighbor {
  uint16_t id;
  uint8_t model; // 0 until the first HELLO arrives
  uint32_t version;
  uint32_t transmitted;
  float rssi;
  float snr;
  uint32_t lastHeardMillis;
};

// What a node knows about the nodes it hears directly.
class NeighborTable {
public:
  // Records any valid frame from a neighbor: refreshes its link quality and age.
  void recordFrame(uint16_t id, float rssi, float snr, uint32_t nowMillis);
  // Records the state that a neighbor announces in its HELLO.
  void recordHello(uint16_t id, uint8_t model, uint32_t version, uint32_t transmitted);
  // Removes the neighbors not heard for NEIGHBOR_EXPIRY_MS.
  void expire(uint32_t nowMillis);

  size_t count() const { return count_; }
  const Neighbor &at(size_t index) const { return entries_[index]; }

private:
  Neighbor *find(uint16_t id);

  Neighbor entries_[MAXIMUM_NEIGHBORS] = {};
  size_t count_ = 0;
};

} // namespace j5

#endif
