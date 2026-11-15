#include "board_pin_port.h"

#include <Arduino.h>

namespace firmware {

void BoardPinPort::configure(uint8_t pin, PinDirection direction) {
  pinMode(pin, direction == PinDirection::Output ? OUTPUT : INPUT);
}

bool BoardPinPort::read(uint8_t pin) { return digitalRead(pin) == HIGH; }

void BoardPinPort::write(uint8_t pin, bool high) { digitalWrite(pin, high ? HIGH : LOW); }

void BoardPinPort::release(uint8_t pin) { pinMode(pin, INPUT); }

} // namespace firmware
