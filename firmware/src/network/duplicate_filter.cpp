#include "duplicate_filter.h"

#include "least_recently_heard.h"

namespace firmware {

bool DuplicateFilter::acceptIfNew(uint16_t source, uint8_t epoch, uint16_t sequence,
                                  uint32_t nowMillis) {
  Entry *entry = findEntry(source);
  if (entry == nullptr) {
    entry = allocateEntry();
    entry->used = true;
    entry->source = source;
  } else if (entry->epoch == epoch) {
    // Same epoch: only a later sequence, in arithmetic modulo 2^16, is new.
    const int16_t distance =
        static_cast<int16_t>(static_cast<uint16_t>(sequence - entry->sequence));
    if (distance <= 0) {
      return false;
    }
  }
  // A different epoch means the source rebooted or its sequence wrapped around.
  entry->epoch = epoch;
  entry->sequence = sequence;
  entry->lastHeardMillis = nowMillis;
  return true;
}

DuplicateFilter::Entry *DuplicateFilter::findEntry(uint16_t source) {
  for (Entry &entry : entries_) {
    if (entry.used && entry.source == source) {
      return &entry;
    }
  }
  return nullptr;
}

DuplicateFilter::Entry *DuplicateFilter::allocateEntry() {
  for (Entry &entry : entries_) {
    if (!entry.used) {
      return &entry;
    }
  }
  return leastRecentlyHeard(entries_, MAXIMUM_TRACKED_SOURCES);
}

} // namespace firmware
