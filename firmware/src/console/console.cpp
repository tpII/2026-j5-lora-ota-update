#include "console.h"

#include <string.h>

namespace firmware {

void Console::begin(SerialTransport &serial, WirelessTransport &wireless) {
  serial_ = &serial;
  wireless_ = &wireless;
}

bool Console::readCommand(char *buffer, size_t capacity, bool &overflowed) {
  overflowed = false;
  if (serial_->readLine(buffer, capacity, overflowed)) {
    return true;
  }
  return wireless_->readLine(buffer, capacity, overflowed);
}

void Console::writeEvent(EventWriter &event) { writeLine(event.finish()); }

void Console::writeDebug(const char *text) {
  // A debug line must never look like an event.
  if (text[0] == '{') {
    return;
  }
  writeLine(text);
}

void Console::writeLine(const char *line) {
  const size_t length = strlen(line);
  if (!serial_->writeLine(line, length)) {
    ++droppedLines_;
  }
  if (!wireless_->writeLine(line, length)) {
    ++droppedLines_;
  }
}

} // namespace firmware
