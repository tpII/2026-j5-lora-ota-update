#ifndef J5_BOARD_PIN_PORT_H
#define J5_BOARD_PIN_PORT_H

#include <stdint.h>

#include "../vm/pin_port.h"

namespace firmware {

// The GPIO pins of the board for the VM, through the Arduino core. In core 3.3.12 OUTPUT includes
// the input, so digitalRead() gives the level of an output without configuring it again.
class BoardPinPort : public PinPort {
public:
  void configure(uint8_t pin, PinDirection direction) override;
  bool read(uint8_t pin) override;
  void write(uint8_t pin, bool high) override;
  void release(uint8_t pin) override;
};

} // namespace firmware

#endif
