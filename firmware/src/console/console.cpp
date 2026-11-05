#include "console.h"

#include <Arduino.h>
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

JsonObject Console::beginEvent(const char *name) {
  event_.clear();
  JsonObject event = event_.to<JsonObject>();
  event["t"] = millis();
  event["ev"] = name;
  return event;
}

void Console::writeEvent() {
  if (measureJson(event_) >= sizeof(line_)) {
    ++droppedLines_;
    return;
  }
  writeLine(line_, serializeJson(event_, line_, sizeof(line_)));
}

void Console::writeEvent(const char *hexadecimalKey, const uint8_t *bytes, size_t length) {
  static const char DIGITS[] = "0123456789abcdef";
  // The document ends with '}': it is replaced by ,"key":"digits"}.
  const size_t documentLength = measureJson(event_);
  const size_t keyLength = strlen(hexadecimalKey);
  const size_t total = documentLength + keyLength + 2 * length + 6;
  if (total >= sizeof(line_)) {
    ++droppedLines_;
    return;
  }
  size_t position = serializeJson(event_, line_, sizeof(line_)) - 1;
  line_[position++] = ',';
  line_[position++] = '"';
  memcpy(line_ + position, hexadecimalKey, keyLength);
  position += keyLength;
  line_[position++] = '"';
  line_[position++] = ':';
  line_[position++] = '"';
  for (size_t index = 0; index < length; ++index) {
    line_[position++] = DIGITS[bytes[index] >> 4];
    line_[position++] = DIGITS[bytes[index] & 0x0F];
  }
  line_[position++] = '"';
  line_[position++] = '}';
  line_[position] = '\0';
  writeLine(line_, position);
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
