#ifndef J5_MILLISECOND_CLOCK_H
#define J5_MILLISECOND_CLOCK_H

#include <stdint.h>

namespace firmware {

// Readings of millis(), which wraps around every 49.7 days. Through a signed difference, two
// readings less than 24.8 days apart keep their order across the wrap.

// Milliseconds from startMillis to nowMillis; negative when nowMillis is the earlier reading, so
// that a deadline can be compared with a reading on either side of it.
constexpr int32_t elapsedMillis(uint32_t startMillis, uint32_t nowMillis) {
  return static_cast<int32_t>(nowMillis - startMillis);
}

// True from deadlineMillis on.
constexpr bool hasReached(uint32_t nowMillis, uint32_t deadlineMillis) {
  return elapsedMillis(deadlineMillis, nowMillis) >= 0;
}

constexpr bool isEarlier(uint32_t firstMillis, uint32_t secondMillis) {
  return elapsedMillis(secondMillis, firstMillis) < 0;
}

} // namespace firmware

#endif
