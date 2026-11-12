#ifndef J5_CONSOLE_H
#define J5_CONSOLE_H

#include <stddef.h>
#include <stdint.h>

#include "../display/debug_display.h"
#include "event_sink.h"
#include "serial_transport.h"
#include "wireless_transport.h"

namespace firmware {

// The node console (docs/protocol/console.md) on the board: the same lines over every transport,
// commands from any of them and the debug text on the OLED.
class Console : public EventOutput {
public:
  void begin(SerialTransport &serial, WirelessTransport &wireless, DebugDisplay &display);

  // Returns true when a command line arrived from any transport.
  bool readCommand(char *buffer, size_t capacity, bool &overflowed);

  uint32_t eventMillis() const override;
  uint8_t writeLine(const char *line, size_t length) override;
  void showDebugText(const char *text) override;

private:
  SerialTransport *serial_ = nullptr;
  WirelessTransport *wireless_ = nullptr;
  DebugDisplay *display_ = nullptr;
};

} // namespace firmware

#endif
