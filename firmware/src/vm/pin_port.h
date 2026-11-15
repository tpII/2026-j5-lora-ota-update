#ifndef J5_PIN_PORT_H
#define J5_PIN_PORT_H

#include <stdint.h>

namespace firmware {

enum class PinDirection : uint8_t { Input, Output };

// The GPIO pins that the instructions PINM, PINR and PINW drive. The VM checks the pin against the
// list of the board and its mode before it calls the port, so the port only does what it is told:
// on the node it calls the Arduino core (board/board_pin_port.h); in the host tests, a recording
// port stands in for the circuit.
class PinPort {
public:
  // An input has no pull resistor; the circuit sets its level.
  virtual void configure(uint8_t pin, PinDirection direction) = 0;
  // The level of the pin: what the circuit puts on an input, what the program wrote on an output.
  virtual bool read(uint8_t pin) = 0;
  virtual void write(uint8_t pin, bool high) = 0;
  // Leaves the pin as an input without pull, as it is after a reset.
  virtual void release(uint8_t pin) = 0;

protected:
  ~PinPort() = default;
};

} // namespace firmware

#endif
