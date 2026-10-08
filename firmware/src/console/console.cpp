#include "console.h"

#include <Arduino.h>
#include <string.h>

namespace firmware {

static constexpr size_t EVENT_LINE_CAPACITY = 1024;

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

JsonObject Console::beginEvent(const char *name) {
  event_.clear();
  JsonObject event = event_.to<JsonObject>();
  event["t"] = millis();
  event["ev"] = name;
  return event;
}

void Console::writeEvent() {
  char line[EVENT_LINE_CAPACITY];
  if (measureJson(event_) >= sizeof(line)) {
    ++droppedLines_;
    return;
  }
  writeLine(line, serializeJson(event_, line, sizeof(line)));
}

void Console::writeDebug(const char *text) {
  // A debug line must never look like an event.
  if (text[0] == '{') {
    return;
  }
  writeLine(text, strlen(text));
}

void Console::writeLine(const char *line, size_t length) {
  if (!serial_->writeLine(line, length)) {
    ++droppedLines_;
  }
  if (!wireless_->writeLine(line, length)) {
    ++droppedLines_;
  }
}

} // namespace firmware
