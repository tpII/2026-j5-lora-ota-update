#ifndef J5_RECORDING_PIN_PORT_H
#define J5_RECORDING_PIN_PORT_H

#include <cstddef>
#include <cstdint>

#include "vm/pin_port.h"

// The GPIO pins of a node under test: the test sets what the circuit puts on each input, and the
// port keeps how each pin is configured and the level of each output.
class RecordingPinPort : public firmware::PinPort {
public:
  // The GPIO of the ESP32 and the ESP32-S3 go from 0 to 48.
  static constexpr size_t PIN_COUNT = 49;

  bool inputLevels[PIN_COUNT] = {};
  bool configured[PIN_COUNT] = {};
  bool outputs[PIN_COUNT] = {};
  bool outputLevels[PIN_COUNT] = {};

  void configure(uint8_t pin, firmware::PinDirection direction) override {
    configured[pin] = true;
    outputs[pin] = direction == firmware::PinDirection::Output;
  }
  bool read(uint8_t pin) override { return outputs[pin] ? outputLevels[pin] : inputLevels[pin]; }
  void write(uint8_t pin, bool high) override { outputLevels[pin] = high; }
  void release(uint8_t pin) override {
    configured[pin] = false;
    outputs[pin] = false;
  }
};

#endif
