#include "event_writer.h"

#include <Arduino.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>

namespace firmware {

EventWriter::EventWriter(const char *eventName) : timestamp_(millis()), eventName_(eventName) {
  appendFormatted("{\"t\":%lu,\"ev\":\"%s\"", static_cast<unsigned long>(timestamp_), eventName);
  needsSeparator_ = true;
}

EventWriter &EventWriter::integer(const char *key, int32_t value) {
  appendKey(key);
  appendFormatted("%ld", static_cast<long>(value));
  return *this;
}

EventWriter &EventWriter::unsignedInteger(const char *key, uint32_t value) {
  appendKey(key);
  appendFormatted("%lu", static_cast<unsigned long>(value));
  return *this;
}

EventWriter &EventWriter::wideInteger(const char *key, int64_t value) {
  appendKey(key);
  appendFormatted("%lld", static_cast<long long>(value));
  return *this;
}

EventWriter &EventWriter::decimal(const char *key, float value, uint8_t decimals) {
  appendKey(key);
  if (isnan(value) || isinf(value)) {
    appendFormatted("null");
  } else {
    appendFormatted("%.*f", static_cast<int>(decimals), static_cast<double>(value));
  }
  return *this;
}

EventWriter &EventWriter::flag(const char *key, bool value) {
  appendKey(key);
  appendFormatted(value ? "true" : "false");
  return *this;
}

EventWriter &EventWriter::text(const char *key, const char *value) {
  appendKey(key);
  if (value == nullptr) {
    appendFormatted("null");
    return *this;
  }
  appendFormatted("\"");
  appendEscaped(value);
  appendFormatted("\"");
  return *this;
}

EventWriter &EventWriter::nodeId(const char *key, uint16_t value) {
  appendKey(key);
  appendFormatted("\"%04X\"", static_cast<unsigned>(value));
  return *this;
}

EventWriter &EventWriter::nullValue(const char *key) {
  appendKey(key);
  appendFormatted("null");
  return *this;
}

EventWriter &EventWriter::beginArray(const char *key) {
  appendKey(key);
  appendFormatted("[");
  needsSeparator_ = false;
  return *this;
}

EventWriter &EventWriter::endArray() {
  appendFormatted("]");
  needsSeparator_ = true;
  return *this;
}

EventWriter &EventWriter::beginObject() {
  if (needsSeparator_) {
    appendFormatted(",");
  }
  appendFormatted("{");
  needsSeparator_ = false;
  return *this;
}

EventWriter &EventWriter::endObject() {
  appendFormatted("}");
  needsSeparator_ = true;
  return *this;
}

const char *EventWriter::finish() {
  appendFormatted("}");
  if (overflowed_) {
    // Never emit a truncated object: replace it with a valid event that reports the loss.
    snprintf(buffer_, sizeof(buffer_), "{\"t\":%lu,\"ev\":\"%s\",\"truncated\":true}",
             static_cast<unsigned long>(timestamp_), eventName_);
  }
  return buffer_;
}

void EventWriter::appendKey(const char *key) {
  if (needsSeparator_) {
    appendFormatted(",");
  }
  appendFormatted("\"%s\":", key);
  needsSeparator_ = true;
}

void EventWriter::appendFormatted(const char *format, ...) {
  if (overflowed_) {
    return;
  }
  va_list arguments;
  va_start(arguments, format);
  const int written = vsnprintf(buffer_ + length_, sizeof(buffer_) - length_, format, arguments);
  va_end(arguments);
  if (written < 0 || static_cast<size_t>(written) >= sizeof(buffer_) - length_) {
    overflowed_ = true;
    return;
  }
  length_ += static_cast<size_t>(written);
}

void EventWriter::appendEscaped(const char *text) {
  for (const char *character = text; *character != '\0'; ++character) {
    const unsigned char value = static_cast<unsigned char>(*character);
    if (value == '"' || value == '\\') {
      appendFormatted("\\%c", value);
    } else if (value < 0x20) {
      appendFormatted("\\u%04x", value);
    } else {
      appendFormatted("%c", value);
    }
  }
}

} // namespace firmware
