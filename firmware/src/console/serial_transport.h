#ifndef J5_SERIAL_TRANSPORT_H
#define J5_SERIAL_TRANSPORT_H

#include <stddef.h>
#include <stdint.h>

#include "command_line.h"

namespace firmware {

// Console over the USB serial port. Writing never blocks: when the transmit buffer lacks room for
// a whole line, the line is dropped.
class SerialTransport {
public:
  void begin(uint32_t baudRate);

  // Returns true when a complete line is available. A line longer than MAXIMUM_COMMAND_LINE_LENGTH
  // keeps its first characters and is reported with overflowed set.
  bool readLine(char *buffer, size_t capacity, bool &overflowed);

  // Returns false when the line was dropped.
  bool writeLine(const char *line, size_t length);

private:
  char pending_[MAXIMUM_COMMAND_LINE_LENGTH + 1] = {};
  size_t pendingLength_ = 0;
  bool pendingOverflowed_ = false;
};

} // namespace firmware

#endif
