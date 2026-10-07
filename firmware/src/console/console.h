#ifndef J5_CONSOLE_H
#define J5_CONSOLE_H

#include <stddef.h>
#include <stdint.h>

#include "event_writer.h"
#include "serial_transport.h"
#include "wireless_transport.h"

namespace firmware {

// The node console (docs/protocol/console.md): the same lines over every transport. Events are
// JSON lines; any other line is debug text for people.
class Console {
public:
  void begin(SerialTransport &serial, WirelessTransport &wireless);

  // Returns true when a command line arrived from any transport.
  bool readCommand(char *buffer, size_t capacity, bool &overflowed);

  void writeEvent(EventWriter &event);
  void writeDebug(const char *text);

  // Lines dropped on any transport because its output buffer was full.
  uint32_t droppedLineCount() const { return droppedLines_; }

private:
  void writeLine(const char *line);

  SerialTransport *serial_ = nullptr;
  WirelessTransport *wireless_ = nullptr;
  uint32_t droppedLines_ = 0;
};

} // namespace firmware

#endif
