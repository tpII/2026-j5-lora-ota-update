// Host tests of the duplicate filter.

#include "host_test_harness.h"
#include "network/duplicate_filter.h"

using namespace firmware;

J5_HOST_TEST(testDuplicateFilter) {
  DuplicateFilter filter;
  CHECK(filter.acceptIfNew(0x3A7F, 5, 10, 0));
  CHECK(!filter.acceptIfNew(0x3A7F, 5, 10, 1));
  CHECK(filter.acceptIfNew(0x3A7F, 5, 11, 2));
  CHECK(!filter.acceptIfNew(0x3A7F, 5, 9, 3));

  bool everyStepAccepted = true;
  for (uint32_t sequence = 12; sequence <= 0xFFFF; ++sequence) {
    everyStepAccepted &= filter.acceptIfNew(0x3A7F, 5, static_cast<uint16_t>(sequence), 4);
  }
  CHECK(everyStepAccepted);
  // One step past 0xFFFF is later in arithmetic modulo 2^16; a jump back is a repetition.
  CHECK(filter.acceptIfNew(0x3A7F, 5, 0x0000, 5));
  CHECK(!filter.acceptIfNew(0x3A7F, 5, 0xFFF0, 5));
  // A new epoch is always accepted.
  CHECK(filter.acceptIfNew(0x3A7F, 6, 0, 6));
  CHECK(!filter.acceptIfNew(0x3A7F, 6, 0, 7));

  // A full table replaces the source heard least recently, wherever its entry is: 0x3A7F, the
  // first one in, was heard again after the others.
  for (uint16_t source = 1; source < MAXIMUM_TRACKED_SOURCES; ++source) {
    CHECK(filter.acceptIfNew(source, 1, 1, 100 + source));
  }
  CHECK(filter.acceptIfNew(0x3A7F, 6, 1, 150));
  CHECK(filter.acceptIfNew(MAXIMUM_TRACKED_SOURCES, 1, 1, 160));
  CHECK(!filter.acceptIfNew(0x3A7F, 6, 1, 170) && !filter.acceptIfNew(2, 1, 1, 170));
  CHECK(filter.acceptIfNew(1, 1, 1, 180));
}
