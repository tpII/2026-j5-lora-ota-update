#ifndef J5_EVENT_WRITER_H
#define J5_EVENT_WRITER_H

#include <stddef.h>
#include <stdint.h>

namespace firmware {

constexpr size_t EVENT_BUFFER_CAPACITY = 1024;

// Builds one console event: a JSON object on a single line that starts with the common fields
// "t" and "ev" (docs/protocol/console.md). Only one level of nesting is supported: an array of
// objects inside the event.
class EventWriter {
public:
  explicit EventWriter(const char *eventName);

  EventWriter &integer(const char *key, int32_t value);
  EventWriter &unsignedInteger(const char *key, uint32_t value);
  EventWriter &wideInteger(const char *key, int64_t value);
  EventWriter &decimal(const char *key, float value, uint8_t decimals);
  EventWriter &flag(const char *key, bool value);
  EventWriter &text(const char *key, const char *value);
  EventWriter &nodeId(const char *key, uint16_t value);
  EventWriter &nullValue(const char *key);

  EventWriter &beginArray(const char *key);
  EventWriter &endArray();
  EventWriter &beginObject();
  EventWriter &endObject();

  // Closes the object and returns the line, without a line terminator.
  const char *finish();

private:
  void appendKey(const char *key);
  void appendFormatted(const char *format, ...);
  void appendEscaped(const char *text);

  char buffer_[EVENT_BUFFER_CAPACITY];
  size_t length_ = 0;
  bool needsSeparator_ = false;
  bool overflowed_ = false;
  uint32_t timestamp_ = 0;
  const char *eventName_ = nullptr;
};

} // namespace firmware

#endif
