#include "event_sink.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "../encoding/hex_codec.h"

namespace firmware {

void EventSink::begin(EventOutput &output) { output_ = &output; }

JsonObject EventSink::beginEvent(ConsoleEvent name) {
  event_.clear();
  JsonObject event = event_.to<JsonObject>();
  event["t"] = output_->eventMillis();
  event["ev"] = consoleEventName(name);
  return event;
}

void EventSink::writeEvent() {
  if (measureJson(event_) >= sizeof(line_)) {
    ++droppedLines_;
    return;
  }
  writeLine(line_, serializeJson(event_, line_, sizeof(line_)));
}

void EventSink::writeEvent(const char *hexadecimalKey, const uint8_t *bytes, size_t length) {
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
  encodeHexBytes(bytes, length, line_ + position);
  position += 2 * length;
  line_[position++] = '"';
  line_[position++] = '}';
  line_[position] = '\0';
  writeLine(line_, position);
}

void EventSink::error(const char *command, ErrorReason reason, const char *detail, int16_t code) {
  setErrorFields(beginEvent(ConsoleEvent::Error), command, reason, detail, code);
  writeEvent();
  debug("error %s %s", command, errorReasonName(reason));
}

void EventSink::debug(const char *format, ...) {
  char text[DEBUG_TEXT_CAPACITY];
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(text, sizeof(text), format, arguments);
  va_end(arguments);
  writeText(text);
  output_->showDebugText(text);
}

void EventSink::writeText(const char *text) {
  // A debug line must never look like an event.
  if (text[0] == '{') {
    return;
  }
  writeLine(text, strlen(text));
}

void EventSink::writeLine(const char *line, size_t length) {
  droppedLines_ += output_->writeLine(line, length);
}

} // namespace firmware
