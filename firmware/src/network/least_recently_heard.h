#ifndef J5_LEAST_RECENTLY_HEARD_H
#define J5_LEAST_RECENTLY_HEARD_H

#include <stddef.h>

#include "../timing/millisecond_clock.h"

namespace firmware {

// The entry to replace when a table of nodes is full: among the first count entries, which must be
// at least one, the one with the earliest lastHeardMillis; the first of them on a tie.
template <typename Entry> Entry *leastRecentlyHeard(Entry *entries, size_t count) {
  Entry *oldest = &entries[0];
  for (size_t index = 1; index < count; ++index) {
    if (isEarlier(entries[index].lastHeardMillis, oldest->lastHeardMillis)) {
      oldest = &entries[index];
    }
  }
  return oldest;
}

} // namespace firmware

#endif
