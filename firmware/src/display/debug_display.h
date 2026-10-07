#ifndef J5_DEBUG_DISPLAY_H
#define J5_DEBUG_DISPLAY_H

#include <stdint.h>

namespace j5 {

constexpr uint8_t DISPLAY_COLUMNS = 21;
constexpr uint8_t DISPLAY_LOG_ROWS = 5;

// Debug text on the 128x64 OLED: a fixed status row and five scrolling log rows with the 6x10
// font. Sending a full frame over I2C blocks for about 30 ms, so the display redraws only when
// something changed, at most every DISPLAY_REFRESH_INTERVAL_MS, and not at all while suspended
// (during test runs).
class DebugDisplay {
public:
  void begin();
  void setStatusLine(const char *text);
  void appendLine(const char *text);
  // While suspended the display keeps its last frame; a redraw during a run could make the
  // receiver miss frames.
  void setSuspended(bool suspended);
  void poll(uint32_t nowMillis);

private:
  void redraw();

  char statusLine_[DISPLAY_COLUMNS + 1] = {};
  bool dirty_ = false;
  bool suspended_ = false;
  bool started_ = false;
  uint32_t lastRedrawMillis_ = 0;
};

} // namespace j5

#endif
