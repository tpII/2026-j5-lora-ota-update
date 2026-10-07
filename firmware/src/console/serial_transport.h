#ifndef J5_SERIAL_TRANSPORT_H
#define J5_SERIAL_TRANSPORT_H

#include <stddef.h>
#include <stdint.h>

#include "../configuration.h"

namespace firmware {

// Console over the USB serial port. Writing never blocks: when the transmit buffer lacks room for
// a whole line, the line is dropped.
class SerialTransport {
public:
  void begin(uint32_t baudRate);

  // Returns true when a complete line is available. Lines longer than the console capacity are
  // discarded and reported with overflowed set.
  bool readLine(char *buffer, size_t capacity, bool &overflowed);

  // Returns false when the line was dropped.
  bool writeLine(const char *line, size_t length);

private:
  char pending_[CONSOLE_LINE_CAPACITY + 1] = {};
  size_t pendingLength_ = 0;
  bool pendingOverflowed_ = false;
};

} // namespace firmware

#endif
