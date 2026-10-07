#include "neighbor_table.h"

namespace firmware {

void NeighborTable::recordFrame(uint16_t id, float rssi, float snr, uint32_t nowMillis) {
  Neighbor *neighbor = find(id);
  if (neighbor == nullptr) {
    if (count_ < MAXIMUM_NEIGHBORS) {
      neighbor = &entries_[count_++];
    } else {
      // Full table: replace the neighbor heard least recently.
      neighbor = &entries_[0];
      for (size_t index = 1; index < count_; ++index) {
        if (static_cast<int32_t>(entries_[index].lastHeardMillis - neighbor->lastHeardMillis) < 0) {
          neighbor = &entries_[index];
        }
      }
    }
    *neighbor = Neighbor{};
    neighbor->id = id;
  }
  neighbor->rssi = rssi;
  neighbor->snr = snr;
  neighbor->lastHeardMillis = nowMillis;
}

void NeighborTable::recordHello(uint16_t id, uint8_t model, uint32_t version,
                                uint32_t transmitted) {
  Neighbor *neighbor = find(id);
  if (neighbor == nullptr) {
    return;
  }
  neighbor->model = model;
  neighbor->version = version;
  neighbor->transmitted = transmitted;
}

void NeighborTable::expire(uint32_t nowMillis) {
  size_t index = 0;
  while (index < count_) {
    if (nowMillis - entries_[index].lastHeardMillis >= NEIGHBOR_EXPIRY_MS) {
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
