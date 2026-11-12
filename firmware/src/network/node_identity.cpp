#include "node_identity.h"

#include <Arduino.h>
#include <Preferences.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

static constexpr const char *PREFERENCES_NAMESPACE = "j5";
static constexpr const char *EPOCH_KEY = "epoch";

static void storeEpoch(uint8_t epoch) {
  Preferences preferences;
  preferences.begin(PREFERENCES_NAMESPACE, false);
  preferences.putUChar(EPOCH_KEY, epoch);
  preferences.end();
}

void NodeIdentity::begin() {
  // getEfuseMac() keeps the first printed byte of the MAC in the lowest byte, so the last two
  // printed bytes are bits 32 to 47.
  const uint64_t mac = ESP.getEfuseMac();
  const uint8_t fifthByte = static_cast<uint8_t>((mac >> 32) & 0xFF);
  const uint8_t sixthByte = static_cast<uint8_t>((mac >> 40) & 0xFF);
  nodeId_ = static_cast<uint16_t>((fifthByte << 8) | sixthByte);
  if (nodeId_ == NO_NODE_ID) {
    nodeId_ = NO_NODE_ID + 1;
  } else if (nodeId_ == BROADCAST_NODE_ID) {
    nodeId_ = BROADCAST_NODE_ID - 1;
  }

  Preferences preferences;
  preferences.begin(PREFERENCES_NAMESPACE, true);
  const uint8_t previousEpoch = preferences.getUChar(EPOCH_KEY, 0);
  preferences.end();
  epoch_ = static_cast<uint8_t>(previousEpoch + 1);
  storeEpoch(epoch_);
  nextSequence_ = 0;
}

void NodeIdentity::assignSequence(uint8_t &epoch, uint16_t &sequence) {
  epoch = epoch_;
  sequence = nextSequence_;
  if (nextSequence_ == 0xFFFF) {
    advanceEpoch();
    nextSequence_ = 0;
  } else {
    ++nextSequence_;
  }
}

void NodeIdentity::advanceEpoch() {
  epoch_ = static_cast<uint8_t>(epoch_ + 1);
  storeEpoch(epoch_);
}

} // namespace firmware
