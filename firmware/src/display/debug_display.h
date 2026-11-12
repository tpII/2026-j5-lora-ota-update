#ifndef J5_DEBUG_DISPLAY_H
#define J5_DEBUG_DISPLAY_H

#include <stdint.h>

namespace firmware {

constexpr uint8_t DISPLAY_COLUMNS = 21;
constexpr uint8_t DISPLAY_LOG_ROWS = 5;
constexpr uint32_t DISPLAY_REFRESH_INTERVAL_MS = 200;

// Debug text on the 128x64 OLED: a fixed status row and DISPLAY_LOG_ROWS scrolling log rows with
// the 6x10 font. Sending a full frame over I2C blocks for about 30 ms, so the display redraws only
// when something changed, at most every DISPLAY_REFRESH_INTERVAL_MS, and only when the main loop
// calls poll(), which it does not while the radio is busy or a test is in progress.
class DebugDisplay {
public:
  void begin();
  void setStatusLine(const char *text);
  void appendLine(const char *text);
  void poll(uint32_t nowMillis);

private:
  void redraw();

  char statusLine_[DISPLAY_COLUMNS + 1] = {};
  bool dirty_ = false;
  uint32_t lastRedrawMillis_ = 0;
};

} // namespace firmware

#endif
