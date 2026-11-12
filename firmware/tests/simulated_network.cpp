#include "simulated_network.h"

#include <cstring>

#include "radio/time_on_air.h"

using namespace firmware;

std::string SimulatedNode::eventsNamed(std::initializer_list<const char *> names) const {
  std::string joined;
  for (const std::string &line : console.output.lines) {
    for (const char *name : names) {
      if (line.find(std::string(R"("ev":")") + name + "\"") != std::string::npos) {
        if (!joined.empty()) {
          joined += '\n';
        }
        joined += line;
        break;
      }
    }
  }
  return joined;
}

const QueuedFrame *SimulatedMedium::transmit(SimulatedNode &sender, uint32_t nowMillis) {
  sender.console.output.millis = nowMillis;
  const QueuedFrame *next = sender.services.nextFrame(nowMillis, sender.settings);
  if (next == nullptr) {
    return nullptr;
  }
  transmitted_ = *next;
  const int64_t startMicros = static_cast<int64_t>(nowMillis) * 1000;
  sender.services.recordTransmitStart(nowMillis, startMicros, sender.settings);
  sender.services.recordTransmitEnd(
      startMicros + computeTimeOnAirMicros(transmitted_.length, sender.settings), nowMillis);
  if (loses && loses(sender, transmitted_)) {
    return &transmitted_;
  }
  for (SimulatedNode *receiver : nodes_) {
    if (receiver != &sender) {
      deliver(*receiver, transmitted_.data, transmitted_.length, nowMillis);
    }
  }
  return &transmitted_;
}

void SimulatedMedium::deliver(SimulatedNode &receiver, const uint8_t *data, size_t length,
                              uint32_t nowMillis) {
  ReceivedFrame frame{};
  std::memcpy(frame.data, data, length);
  frame.length = length;
  frame.rssi = rssi;
  frame.snr = snr;
  frame.integrityVerified = true;
  frame.receivedAtMicros = static_cast<int64_t>(nowMillis) * 1000;
  receiver.console.output.millis = nowMillis;
  receiver.services.receive(frame, nowMillis, receiver.settings);
}

void SimulatedMedium::pass(uint32_t nowMillis) {
  for (SimulatedNode *node : nodes_) {
    transmit(*node, nowMillis);
    node->console.output.millis = nowMillis;
    node->services.poll(nowMillis);
  }
}

void SimulatedMedium::run(uint32_t fromMillis, uint32_t toMillis, uint32_t stepMillis) {
  for (uint32_t now = fromMillis; now <= toMillis; now += stepMillis) {
    pass(now);
  }
}
