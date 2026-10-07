#ifndef J5_DUPLICATE_FILTER_H
#define J5_DUPLICATE_FILTER_H

#include <stdint.h>

#include "../configuration.h"

namespace j5 {

// Remembers, per source, the epoch and sequence of the last accepted frame
// (docs/adrs/0005-frame-without-hop-count.md).
class DuplicateFilter {
public:
  // Returns true and records the frame when it is newer than the last one accepted from its
  // source; returns false for a repeated or older frame.
  bool acceptIfNew(uint16_t source, uint8_t epoch, uint16_t sequence, uint32_t nowMillis);

private:
  struct Entry {
    uint16_t source;
    uint8_t epoch;
    uint16_t sequence;
    uint32_t lastHeardMillis;
    bool used;
  };

  Entry *findEntry(uint16_t source);
  // Returns a free entry or, when the table is full, the one heard least recently.
  Entry *allocateEntry();

  Entry entries_[MAXIMUM_TRACKED_SOURCES] = {};
};

} // namespace j5

#endif
