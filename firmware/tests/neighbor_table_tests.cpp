// Host tests of the neighbor table.

#include "host_test_harness.h"
#include "network/neighbor_table.h"

using namespace firmware;

static AnnouncedState announcedVersion(uint32_t version) {
  AnnouncedState state{};
  state.modelKnown = true;
  state.model = BoardModel::HeltecV43;
  state.lastFault = VmFault::EndOfProgram;
  state.vmFailing = true;
  state.version = version;
  state.available = version + 1;
  state.transmitted = 42;
  return state;
}

J5_HOST_TEST(testNeighborTableHello) {
  NeighborTable table;
  // A HELLO alone adds the neighbor, with its link quality and what it announces.
  table.recordHello(0x3A7F, announcedVersion(7), -71.5f, 6.25f, 1000);
  CHECK(table.neighbors(1000).size() == 1 && table.contains(0x3A7F, 1000));
  const Neighbor &neighbor = *table.neighbors(1000).begin();
  CHECK(neighbor.id == 0x3A7F && neighbor.rssi == -71.5f && neighbor.snr == 6.25f);
  CHECK(neighbor.lastHeardMillis == 1000);
  CHECK(neighbor.announced.modelKnown && neighbor.announced.model == BoardModel::HeltecV43);
  CHECK(neighbor.announced.version == 7 && neighbor.announced.available == 8);
  CHECK(neighbor.announced.lastFault == VmFault::EndOfProgram && neighbor.announced.vmFailing);
  CHECK(neighbor.announced.transmitted == 42);

  // Any other frame refreshes the link quality and keeps the announced state.
  table.recordFrame(0x3A7F, -80.0f, -2.5f, 2000);
  const NeighborList refreshed = table.neighbors(2000);
  CHECK(refreshed.size() == 1 && refreshed.begin()->rssi == -80.0f);
  CHECK(refreshed.begin()->lastHeardMillis == 2000 && refreshed.begin()->announced.version == 7);

  // A neighbor heard only through other frames has announced nothing yet.
  table.recordFrame(0x00F4, -90.0f, 1.0f, 2500);
  const NeighborList both = table.neighbors(2500);
  const Neighbor &silent = both.begin()[1];
  CHECK(both.size() == 2 && silent.id == 0x00F4 && !silent.announced.modelKnown);
  CHECK(silent.announced.version == 0 && silent.announced.lastFault == VmFault::None);
}

J5_HOST_TEST(testNeighborTableExpiry) {
  // No read sees a neighbor that isNeighborExpired() counts as expired, whoever reads first.
  NeighborTable table;
  table.recordFrame(0x0001, -60.0f, 5.0f, 1000);
  table.recordFrame(0x0002, -60.0f, 5.0f, 5000);
  CHECK(table.neighbors(1000 + NEIGHBOR_EXPIRY_MS - 1).size() == 2);
  CHECK(!table.contains(0x0001, 1000 + NEIGHBOR_EXPIRY_MS));
  CHECK(table.contains(0x0002, 1000 + NEIGHBOR_EXPIRY_MS));
  CHECK(table.neighbors(1000 + NEIGHBOR_EXPIRY_MS).size() == 1);
  CHECK(table.neighbors(5000 + NEIGHBOR_EXPIRY_MS).size() == 0);
}

J5_HOST_TEST(testNeighborTableReplacement) {
  NeighborTable table;
  // Across the wrap of millis(), neighbor 2 is the one heard least recently once neighbor 1, the
  // first one in, is heard again; the readings past the wrap are the smallest numbers.
  const uint32_t start = 0xFFFFFF00u;
  for (uint16_t id = 1; id <= MAXIMUM_NEIGHBORS; ++id) {
    table.recordFrame(id, -60.0f, 5.0f, start + 0x40u * id);
  }
  const uint32_t now = start + 0x40u * static_cast<uint32_t>(MAXIMUM_NEIGHBORS + 1);
  table.recordFrame(1, -60.0f, 5.0f, now);
  CHECK(table.neighbors(now).size() == MAXIMUM_NEIGHBORS);
  table.recordHello(0x3A7F, announcedVersion(3), -50.0f, 7.0f, now);
  CHECK(table.neighbors(now).size() == MAXIMUM_NEIGHBORS);
  CHECK(!table.contains(2, now) && table.contains(1, now) && table.contains(3, now));
  CHECK(table.contains(0x3A7F, now));
}
