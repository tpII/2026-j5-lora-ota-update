#include "presence_service.h"

#include <esp_random.h>
#include <math.h>

#include "../network/byte_order.h"
#include "../network/link_quality.h"

namespace firmware {

static uint32_t randomBetween(uint32_t minimum, uint32_t maximum) {
  return minimum + esp_random() % (maximum - minimum + 1);
}

// Signed, because the main loop reads the clock once per pass and a command handled later in the
// same pass starts the hold with a newer reading.
static int32_t elapsedSince(uint32_t startMillis, uint32_t nowMillis) {
  return static_cast<int32_t>(nowMillis - startMillis);
}

void PresenceService::begin(uint32_t nowMillis) {
  nextMillis_ =
      nowMillis + randomBetween(FIRST_HELLO_MINIMUM_DELAY_MS, FIRST_HELLO_MAXIMUM_DELAY_MS);
}

bool PresenceService::isDue(uint32_t nowMillis) const {
  return !suspended_ && !held_ && static_cast<int32_t>(nowMillis - nextMillis_) >= 0;
}

void PresenceService::scheduleNext(uint32_t nowMillis) {
  nextMillis_ = nowMillis +
                randomBetween(HELLO_PERIOD_MS - HELLO_JITTER_MS, HELLO_PERIOD_MS + HELLO_JITTER_MS);
}

void PresenceService::setSuspended(bool suspended, uint32_t nowMillis) {
  if (suspended == suspended_) {
    return;
  }
  suspended_ = suspended;
  if (!suspended_) {
    scheduleResumption(nowMillis);
  }
}

void PresenceService::hold(uint32_t durationMillis, uint32_t nowMillis) {
  held_ = true;
  holdStartMillis_ = nowMillis;
  holdDurationMillis_ = durationMillis;
}

void PresenceService::release(uint32_t nowMillis) {
  if (!held_) {
    return;
  }
  held_ = false;
  scheduleResumption(nowMillis);
}

bool PresenceService::hasHoldExpired(uint32_t nowMillis) const {
  return held_ &&
         elapsedSince(holdStartMillis_, nowMillis) >= static_cast<int32_t>(holdDurationMillis_);
}

uint32_t PresenceService::holdRemainingMillis(uint32_t nowMillis) const {
  if (!held_) {
    return 0;
  }
  const int32_t elapsed = elapsedSince(holdStartMillis_, nowMillis);
  if (elapsed <= 0) {
    return holdDurationMillis_;
  }
  return static_cast<uint32_t>(elapsed) >= holdDurationMillis_
             ? 0
             : holdDurationMillis_ - static_cast<uint32_t>(elapsed);
}

void PresenceService::scheduleResumption(uint32_t nowMillis) {
  // Resume soon, but not at the same instant as the other node of the run or of the test.
  nextMillis_ =
      nowMillis + randomBetween(FIRST_HELLO_MINIMUM_DELAY_MS, FIRST_HELLO_MAXIMUM_DELAY_MS);
}

size_t PresenceService::encodePayload(const HelloContent &content, uint8_t *output) {
  const uint8_t count =
      content.neighborCount <= MAXIMUM_NEIGHBORS ? content.neighborCount : MAXIMUM_NEIGHBORS;
  output[0] = content.model;
  writeUint32(output + 1, content.version);
  writeUint32(output + 5, content.transmitted);
  output[9] = count;
  uint8_t *entry = output + HELLO_FIXED_SIZE;
  for (uint8_t index = 0; index < count; ++index) {
    writeUint16(entry, content.neighbors[index].id);
    entry[2] = encodeRssi(content.neighbors[index].rssi);
    entry[3] = encodeSnr(content.neighbors[index].snr);
    entry += HELLO_NEIGHBOR_SIZE;
  }
  return HELLO_FIXED_SIZE + count * HELLO_NEIGHBOR_SIZE;
}

bool PresenceService::decodePayload(const uint8_t *payload, size_t length, HelloContent &content) {
  if (length < HELLO_FIXED_SIZE) {
    return false;
  }
  const uint8_t count = payload[9];
  if (count > MAXIMUM_NEIGHBORS || length != HELLO_FIXED_SIZE + count * HELLO_NEIGHBOR_SIZE) {
    return false;
  }
  content.model = payload[0];
  content.version = readUint32(payload + 1);
  content.transmitted = readUint32(payload + 5);
  content.neighborCount = count;
  const uint8_t *entry = payload + HELLO_FIXED_SIZE;
  for (uint8_t index = 0; index < count; ++index) {
    content.neighbors[index].id = readUint16(entry);
    content.neighbors[index].rssi = decodeRssi(entry[2]);
    content.neighbors[index].snr = decodeSnr(entry[3]);
    entry += HELLO_NEIGHBOR_SIZE;
  }
  return true;
}

} // namespace firmware
