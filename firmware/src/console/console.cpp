#include "console.h"

#include <Arduino.h>

namespace firmware {

void Console::begin(SerialTransport &serial, WirelessTransport &wireless, DebugDisplay &display) {
  serial_ = &serial;
  wireless_ = &wireless;
  display_ = &display;
}

bool Console::readCommand(char *buffer, size_t capacity, bool &overflowed) {
  overflowed = false;
  if (serial_->readLine(buffer, capacity, overflowed)) {
    return true;
  }
  return wireless_->readLine(buffer, capacity, overflowed);
}

uint32_t Console::eventMillis() const { return millis(); }

uint8_t Console::writeLine(const char *line, size_t length) {
  uint8_t dropped = 0;
  if (!serial_->writeLine(line, length)) {
    ++dropped;
  }
  if (!wireless_->writeLine(line, length)) {
    ++dropped;
  }
  return dropped;
}

void Console::showDebugText(const char *text) { display_->appendLine(text); }

} // namespace firmware
