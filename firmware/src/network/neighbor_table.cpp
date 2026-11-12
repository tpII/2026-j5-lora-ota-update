#include "neighbor_table.h"

#include "least_recently_heard.h"

namespace firmware {

void NeighborTable::recordFrame(uint16_t id, float rssi, float snr, uint32_t nowMillis) {
  Neighbor *neighbor = find(id);
  if (neighbor == nullptr) {
    neighbor =
        count_ < MAXIMUM_NEIGHBORS ? &entries_[count_++] : leastRecentlyHeard(entries_, count_);
    *neighbor = Neighbor{};
    neighbor->id = id;
  }
  neighbor->rssi = rssi;
  neighbor->snr = snr;
  neighbor->lastHeardMillis = nowMillis;
}

void NeighborTable::recordHello(uint16_t id, const AnnouncedState &announced, float rssi, float snr,
                                uint32_t nowMillis) {
  recordFrame(id, rssi, snr, nowMillis);
  find(id)->announced = announced;
}

NeighborList NeighborTable::neighbors(uint32_t nowMillis) {
  expire(nowMillis);
  return NeighborList(entries_, count_);
}

bool NeighborTable::contains(uint16_t id, uint32_t nowMillis) {
  expire(nowMillis);
  return find(id) != nullptr;
}

void NeighborTable::expire(uint32_t nowMillis) {
  size_t index = 0;
  while (index < count_) {
    if (isNeighborExpired(nowMillis - entries_[index].lastHeardMillis)) {
      entries_[index] = entries_[count_ - 1];
      --count_;
    } else {
      ++index;
    }
  }
}

Neighbor *NeighborTable::find(uint16_t id) {
  for (size_t index = 0; index < count_; ++index) {
    if (entries_[index].id == id) {
      return &entries_[index];
    }
  }
  return nullptr;
}

} // namespace firmware
