#ifndef J5_SIMULATED_NETWORK_H
#define J5_SIMULATED_NETWORK_H

#include <cstddef>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <string>
#include <vector>

#include "application/node_services.h"
#include "console_line_recorder.h"
#include "radio/radio_settings.h"
#include "recording_pin_port.h"

// Numbers the frames of a node under test: a fixed epoch and a sequence from 0.
class CountingSequenceSource : public firmware::SequenceSource {
public:
  uint8_t epoch = 1;
  uint16_t nextSequence = 0;

  void assignSequence(uint8_t &frameEpoch, uint16_t &sequence) override {
    frameEpoch = epoch;
    sequence = nextSequence++;
  }
};

// A node under test: its services on a recording console, as NodeApplication connects them, with
// the radio settings of its radio.
struct SimulatedNode {
  RecordingConsole console;
  CountingSequenceSource sequences;
  RecordingPinPort pins;
  firmware::RadioSettings settings = firmware::defaultRadioSettings();
  firmware::NodeServices services;
  uint16_t id;

  explicit SimulatedNode(uint16_t nodeId,
                         firmware::BoardModel model = firmware::BoardModel::HeltecV2,
                         uint32_t nowMillis = 0)
      : id(nodeId) {
    services.begin(console.events, nodeId, model, pins, sequences, nowMillis);
  }

  // The event lines of the console since the last clear() whose ev is one of the names, joined
  // with "\n".
  std::string eventsNamed(std::initializer_list<const char *> names) const;
};

// The air between nodes under test, in place of their radios. A pass serves every node as the main
// loop of NodeApplication does: its transmitter and then its timers. A frame that a node starts is
// on the air for its time on air by the formula, ends in the same pass and reaches every other
// node at once, unless the medium loses it.
class SimulatedMedium {
public:
  explicit SimulatedMedium(std::initializer_list<SimulatedNode *> nodes) : nodes_(nodes) {}

  // Returns true for a frame that the medium loses, for every receiver.
  std::function<bool(const SimulatedNode &sender, const firmware::QueuedFrame &frame)> loses;
  float rssi = -60.0f;
  float snr = 8.0f;

  // One pass of every node at nowMillis.
  void pass(uint32_t nowMillis);
  // A pass every stepMillis, from fromMillis to toMillis included.
  void run(uint32_t fromMillis, uint32_t toMillis, uint32_t stepMillis);
  // Transmits the next frame of the node, if one is due, without serving its timers; returns the
  // frame, or nullptr.
  const firmware::QueuedFrame *transmit(SimulatedNode &sender, uint32_t nowMillis);
  // Delivers the bytes to the node as its radio would.
  void deliver(SimulatedNode &receiver, const uint8_t *data, size_t length, uint32_t nowMillis);

private:
  std::vector<SimulatedNode *> nodes_;
  firmware::QueuedFrame transmitted_ = {};
};

#endif
