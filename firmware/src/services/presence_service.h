#ifndef J5_PRESENCE_SERVICE_H
#define J5_PRESENCE_SERVICE_H

#include <stddef.h>
#include <stdint.h>

#include "../configuration.h"
#include "../vm/virtual_machine.h"

namespace firmware {

constexpr size_t HELLO_FIXED_SIZE = 15;
constexpr size_t HELLO_NEIGHBOR_SIZE = 4;

// Byte vm of the HELLO: bits 0 to 2 hold the last fault since the activation, with the values of
// VmFault, and bit 3 is set when the last tick ended in a fault. Bits 4 to 7 are reserved.
constexpr uint8_t VM_STATUS_FAULT_MASK = 0x07;
constexpr uint8_t VM_STATUS_FAILING_BIT = 0x08;

inline uint8_t encodeVmStatus(VmFault lastFault, bool lastTickFaulted) {
  return static_cast<uint8_t>((static_cast<uint8_t>(lastFault) & VM_STATUS_FAULT_MASK) |
                              (lastTickFaulted ? VM_STATUS_FAILING_BIT : 0));
}

inline uint8_t vmStatusFault(uint8_t status) { return status & VM_STATUS_FAULT_MASK; }

inline bool isVmStatusFailing(uint8_t status) { return (status & VM_STATUS_FAILING_BIT) != 0; }

struct HelloNeighborEntry {
  uint16_t id;
  int16_t rssi;
  float snr;
};

// Body of a HELLO message (docs/protocol/frame.md).
struct HelloContent {
  uint8_t model;
  uint32_t version;   // active version
  uint32_t available; // available version
  uint8_t vmStatus;
  uint32_t transmitted;
  uint8_t neighborCount;
  HelloNeighborEntry neighbors[MAXIMUM_NEIGHBORS];
};

// Schedules the periodic HELLO: every HELLO_PERIOD_MS with a random variation of
// +/- HELLO_JITTER_MS, never while suspended or held. A change of version asks for an immediate
// HELLO, which bursts do not postpone but suspensions and holds do.
class PresenceService {
public:
  void begin(uint32_t nowMillis);
  bool isDue(uint32_t nowMillis) const;
  void requestImmediate() { immediateRequested_ = true; }
  bool isImmediateDue() const { return immediateRequested_ && !isInhibited(); }
  // Any HELLO sent: the next periodic one follows the usual period.
  void scheduleNext(uint32_t nowMillis);
  void setSuspended(bool suspended, uint32_t nowMillis);
  // Suspended by a run or held by the operator: no HELLO, fragment or report leaves the node.
  bool isInhibited() const { return suspended_ || held_; }

  // Hold requested by the operator ("presence off"): no HELLO until release() or until the hold
  // expires, so a hold left behind by a lost console does not silence the node for good.
  void hold(uint32_t durationMillis, uint32_t nowMillis);
  void release(uint32_t nowMillis);
  bool isHeld() const { return held_; }
  bool hasHoldExpired(uint32_t nowMillis) const;
  uint32_t holdRemainingMillis(uint32_t nowMillis) const;

  static size_t encodePayload(const HelloContent &content, uint8_t *output);
  static bool decodePayload(const uint8_t *payload, size_t length, HelloContent &content);

private:
  void scheduleResumption(uint32_t nowMillis);

  uint32_t nextMillis_ = 0;
  bool immediateRequested_ = false;
  bool suspended_ = false;
  bool held_ = false;
  uint32_t holdStartMillis_ = 0;
  uint32_t holdDurationMillis_ = 0;
};

} // namespace firmware

#endif
