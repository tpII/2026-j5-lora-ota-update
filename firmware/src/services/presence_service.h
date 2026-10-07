#ifndef J5_PRESENCE_SERVICE_H
#define J5_PRESENCE_SERVICE_H

#include <stddef.h>
#include <stdint.h>

#include "../configuration.h"

namespace firmware {

constexpr size_t HELLO_FIXED_SIZE = 10;
constexpr size_t HELLO_NEIGHBOR_SIZE = 4;

struct HelloNeighborEntry {
  uint16_t id;
  int16_t rssi;
  float snr;
};

// Body of a HELLO message (docs/protocol/frame.md).
struct HelloContent {
  uint8_t model;
  uint32_t version;
  uint32_t transmitted;
  uint8_t neighborCount;
  HelloNeighborEntry neighbors[MAXIMUM_NEIGHBORS];
};

// Schedules the periodic HELLO: every HELLO_PERIOD_MS with a random variation of
// +/- HELLO_JITTER_MS, never while suspended.
class PresenceService {
public:
  void begin(uint32_t nowMillis);
  bool isDue(uint32_t nowMillis) const;
  void scheduleNext(uint32_t nowMillis);
  void setSuspended(bool suspended, uint32_t nowMillis);

  static size_t encodePayload(const HelloContent &content, uint8_t *output);
  static bool decodePayload(const uint8_t *payload, size_t length, HelloContent &content);

private:
  uint32_t nextMillis_ = 0;
  bool suspended_ = false;
};

} // namespace firmware

#endif
