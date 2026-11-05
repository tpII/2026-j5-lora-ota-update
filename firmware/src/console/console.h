#ifndef J5_CONSOLE_H
#define J5_CONSOLE_H

#include <ArduinoJson.h>
#include <stddef.h>
#include <stdint.h>

#include "../configuration.h"
#include "serial_transport.h"
#include "wireless_transport.h"

namespace firmware {

// The node console (docs/protocol/console.md): the same lines over every transport. Events are
// JSON lines built with ArduinoJson; any other line is debug text for people.
class Console {
public:
  void begin(SerialTransport &serial, WirelessTransport &wireless);

  // Returns true when a command line arrived from any transport.
  bool readCommand(char *buffer, size_t capacity, bool &overflowed);

  // Starts an event: clears the shared document and fills the common fields "t" and "ev". The
  // caller adds its own fields to the returned object and then calls writeEvent().
  JsonObject beginEvent(const char *name);
  void writeEvent();
  // Writes the event with one more field at the end: the bytes as a text of two lowercase
  // hexadecimal digits per byte. The digits go straight into the line, so a whole program does not
  // need a copy inside the JSON document.
  void writeEvent(const char *hexadecimalKey, const uint8_t *bytes, size_t length);
  void writeDebug(const char *text);

  // Lines dropped on any transport because its output buffer was full.
  uint32_t droppedLineCount() const { return droppedLines_; }

private:
  void writeLine(const char *line, size_t length);

  SerialTransport *serial_ = nullptr;
  WirelessTransport *wireless_ = nullptr;
  JsonDocument event_;
  // Static storage rather than the stack of loop(), because the program event takes over 2 KB.
  char line_[EVENT_LINE_CAPACITY] = {};
  uint32_t droppedLines_ = 0;
};

} // namespace firmware

#endif
