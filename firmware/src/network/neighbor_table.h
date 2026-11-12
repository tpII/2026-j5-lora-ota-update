#ifndef J5_NEIGHBOR_TABLE_H
#define J5_NEIGHBOR_TABLE_H

#include <stddef.h>
#include <stdint.h>

#include "../messages/hello_message.h"
#include "../protocol/protocol_contract.h"

namespace firmware {

struct Neighbor {
  uint16_t id;
  AnnouncedState announced;
  float rssi;
  float snr;
  uint32_t lastHeardMillis;
};

// The neighbors of the table at one moment, for a range-based for loop. It stays valid until the
// table changes.
class NeighborList {
public:
  NeighborList(const Neighbor *entries, size_t count) : entries_(entries), count_(count) {}

  const Neighbor *begin() const { return entries_; }
  const Neighbor *end() const { return entries_ + count_; }
  size_t size() const { return count_; }

private:
  const Neighbor *entries_;
  size_t count_;
};

// What a node knows about the nodes it hears directly: up to MAXIMUM_NEIGHBORS, the ones that a
// HELLO lists. Every read takes the clock reading of the caller and first removes the neighbors
// that isNeighborExpired() finds expired, so no reader sees one.
class NeighborTable {
public:
  // Records any valid frame from a neighbor: refreshes its link quality and age, and adds it when
  // it is new.
  void recordFrame(uint16_t id, float rssi, float snr, uint32_t nowMillis);
  // Records a HELLO from a neighbor as recordFrame does, and the state that it announces.
  void recordHello(uint16_t id, const AnnouncedState &announced, float rssi, float snr,
                   uint32_t nowMillis);

  NeighborList neighbors(uint32_t nowMillis);
  bool contains(uint16_t id, uint32_t nowMillis);

private:
  void expire(uint32_t nowMillis);
  Neighbor *find(uint16_t id);

  Neighbor entries_[MAXIMUM_NEIGHBORS] = {};
  size_t count_ = 0;
};

} // namespace firmware

#endif
