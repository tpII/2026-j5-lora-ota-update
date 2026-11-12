#ifndef J5_EVENT_SINK_H
#define J5_EVENT_SINK_H

#include <ArduinoJson.h>
#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"
#include "event_fields.h"

namespace firmware {

// The longest event is program, with the whole program as two hexadecimal digits per byte. A
// longer event is dropped and counted in droppedLineCount().
constexpr size_t EVENT_LINE_CAPACITY = 2 * PROGRAM_CAPACITY + 256;

// Where the lines of the node go: the console transports and the OLED. On the board the console
// implements it; the host tests record the lines.
class EventOutput {
public:
  // The "t" field of an event: milliseconds since the boot when the event is written.
  virtual uint32_t eventMillis() const = 0;
  // Writes a console line on every transport and returns on how many of them it was dropped.
  virtual uint8_t writeLine(const char *line, size_t length) = 0;
  // Shows a line of debug text on the OLED.
  virtual void showDebugText(const char *text) = 0;

protected:
  ~EventOutput() = default;
};

// The events and the debug text of the node (docs/protocol/console.md). Every module that emits
// events writes them here: an event is a JSON line built with ArduinoJson, and debug text is the
// same line on the console and on the OLED.
class EventSink {
public:
  void begin(EventOutput &output);

  // Starts an event of the contract: clears the shared document and fills the common fields "t"
  // and "ev". The caller adds its own fields to the returned object and then calls writeEvent().
  JsonObject beginEvent(ConsoleEvent name);
  void writeEvent();
  // Writes the event with one more field at the end: the bytes as a text of two lowercase
  // hexadecimal digits per byte. The digits go straight into the line, so a whole program does not
  // need a copy inside the JSON document.
  void writeEvent(const char *hexadecimalKey, const uint8_t *bytes, size_t length);

  // An error event, followed by the debug text "error <command> <reason>".
  void error(const char *command, ErrorReason reason, const char *detail = nullptr,
             int16_t code = 0);

  // Debug text, on the console and on the OLED. A text longer than DEBUG_TEXT_CAPACITY - 1 is cut.
  void debug(const char *format, ...) __attribute__((format(printf, 2, 3)));
  // A line of debug text on the console only, never on the OLED.
  void writeText(const char *text);

  // Lines dropped because they did not fit the line buffer, or on a transport whose output
  // buffer was full.
  uint32_t droppedLineCount() const { return droppedLines_; }

  static constexpr size_t DEBUG_TEXT_CAPACITY = 64;

private:
  void writeLine(const char *line, size_t length);

  EventOutput *output_ = nullptr;
  JsonDocument event_;
  // Static storage rather than the 8 KB stack that the ESP32 core gives loop(), of which a line of
  // the program event would take a large part.
  char line_[EVENT_LINE_CAPACITY] = {};
  uint32_t droppedLines_ = 0;
};

} // namespace firmware

#endif
