#include "presence_service.h"

#include <esp_random.h>
#include <math.h>

#include "../timing/millisecond_clock.h"

namespace firmware {

static uint32_t randomBetween(uint32_t minimum, uint32_t maximum) {
  return minimum + esp_random() % (maximum - minimum + 1);
}

static void setAnnouncedFields(JsonObject event, const AnnouncedState &state) {
  if (state.modelKnown) {
    event["model"] = boardModelName(state.model);
  } else {
    event["model"] = nullptr;
  }
  event["version"] = state.version;
  event["available"] = state.available;
  if (state.lastFault == VmFault::None) {
    event["vm_fault"] = nullptr;
  } else {
    event["vm_fault"] = vmFaultName(state.lastFault);
  }
  event["vm_failing"] = state.vmFailing;
  event["tx"] = state.transmitted;
}

void PresenceService::begin(EventSink &events, NeighborTable &neighbors, HelloListener &listener,
                            uint32_t nowMillis) {
  events_ = &events;
  neighbors_ = &neighbors;
  listener_ = &listener;
  nextMillis_ =
      nowMillis + randomBetween(FIRST_HELLO_MINIMUM_DELAY_MS, FIRST_HELLO_MAXIMUM_DELAY_MS);
}

bool PresenceService::isPeriodicHelloDue(uint32_t nowMillis) const {
  return hasReached(nowMillis, nextMillis_);
}

size_t PresenceService::buildHello(const AnnouncedState &announced, uint32_t nowMillis,
                                   FrameDescription &description, uint8_t *payload) {
  HelloMessage message{};
  message.announced = announced;
  for (const Neighbor &neighbor : neighbors_->neighbors(nowMillis)) {
    HelloNeighborEntry &entry = message.neighbors[message.neighborCount++];
    entry.id = neighbor.id;
    entry.rssi = static_cast<int16_t>(lroundf(neighbor.rssi));
    entry.snr = neighbor.snr;
  }
  description.type = MessageType::Hello;
  description.destination = BROADCAST_NODE_ID;

  // Any HELLO sent: the next periodic one follows the usual period.
  immediateRequested_ = false;
  nextMillis_ = nowMillis +
                randomBetween(HELLO_PERIOD_MS - HELLO_JITTER_MS, HELLO_PERIOD_MS + HELLO_JITTER_MS);
  return encodeHello(message, payload);
}

void PresenceService::onRunsEnded(uint32_t nowMillis) { scheduleResumption(nowMillis); }

void PresenceService::hold(uint32_t durationMillis, uint32_t nowMillis) {
  held_ = true;
  holdStartMillis_ = nowMillis;
  holdDurationMillis_ = durationMillis;
  reportPresence(nowMillis);
  events_->debug("hello off");
}

void PresenceService::release(uint32_t nowMillis) {
  endHold(nowMillis);
  reportPresence(nowMillis);
  events_->debug("hello on");
}

void PresenceService::poll(uint32_t nowMillis) {
  if (held_ && nowMillis - holdStartMillis_ >= holdDurationMillis_) {
    endHold(nowMillis);
    reportPresence(nowMillis);
    events_->debug("hello on (hold expired)");
  }
}

void PresenceService::reportPresence(uint32_t nowMillis) {
  JsonObject event = events_->beginEvent(ConsoleEvent::Presence);
  event["state"] = presenceStateName(held_ ? PresenceState::Off : PresenceState::On);
  if (held_) {
    event["remaining"] = (holdRemainingMillis(nowMillis) + 999) / 1000;
  } else {
    event["remaining"] = nullptr;
  }
  events_->writeEvent();
}

void PresenceService::reportNeighbors(uint32_t nowMillis) {
  for (const Neighbor &neighbor : neighbors_->neighbors(nowMillis)) {
    JsonObject event = events_->beginEvent(ConsoleEvent::Neighbor);
    setNodeId(event, "id", neighbor.id);
    setAnnouncedFields(event, neighbor.announced);
    setLinkQuality(event, neighbor.rssi, neighbor.snr);
    event["age"] = nowMillis - neighbor.lastHeardMillis;
    events_->writeEvent();
  }
}

void PresenceService::handleHello(const FrameHeader &header, const HelloMessage &message,
                                  const ReceivedFrame &frame, uint32_t nowMillis) {
  neighbors_->recordHello(header.source, message.announced, frame.rssi, frame.snr, nowMillis);

  JsonObject event = events_->beginEvent(ConsoleEvent::Hello);
  setNodeId(event, "src", header.source);
  event["epoch"] = header.epoch;
  event["seq"] = header.sequence;
  setAnnouncedFields(event, message.announced);
  setLinkQuality(event, frame.rssi, frame.snr);
  event["ferr"] = lroundf(frame.frequencyError);
  JsonArray neighbors = event["neighbors"].to<JsonArray>();
  for (uint8_t index = 0; index < message.neighborCount; ++index) {
    const HelloNeighborEntry &entry = message.neighbors[index];
    JsonObject neighbor = neighbors.add<JsonObject>();
    setNodeId(neighbor, "id", entry.id);
    neighbor["rssi"] = entry.rssi;
    setSnr(neighbor, "snr", entry.snr);
  }
  events_->writeEvent();
  events_->debug("hello %04X %.0f dBm", header.source, frame.rssi);
  listener_->onNeighborHello(header.source, message.announced, nowMillis);
}

void PresenceService::endHold(uint32_t nowMillis) {
  if (!held_) {
    return;
  }
  held_ = false;
  scheduleResumption(nowMillis);
}

void PresenceService::scheduleResumption(uint32_t nowMillis) {
  // Resume soon, but not at the same instant as the other node of the run or of the test.
  nextMillis_ =
      nowMillis + randomBetween(FIRST_HELLO_MINIMUM_DELAY_MS, FIRST_HELLO_MAXIMUM_DELAY_MS);
}

uint32_t PresenceService::holdRemainingMillis(uint32_t nowMillis) const {
  const uint32_t elapsed = nowMillis - holdStartMillis_;
  return elapsed >= holdDurationMillis_ ? 0 : holdDurationMillis_ - elapsed;
}

} // namespace firmware
