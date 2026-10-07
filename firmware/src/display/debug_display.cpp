#include "debug_display.h"

#include <Arduino.h>
#include <U8g2lib.h>
#include <stdio.h>

#include "../configuration.h"

namespace j5 {

namespace {

constexpr uint8_t STATUS_ROW_TOP = 0;
constexpr uint8_t SEPARATOR_ROW = 11;
constexpr uint8_t LOG_TOP = 13;

// The variant of each board defines the OLED reset and I2C pins. The V4.3 carries an SSD1315,
// which accepts the SSD1306 command set.
U8G2_SSD1306_128X64_NONAME_F_HW_I2C display(U8G2_R0, RST_OLED, SCL_OLED, SDA_OLED);
U8G2LOG logWindow;
uint8_t logBuffer[DISPLAY_COLUMNS * DISPLAY_LOG_ROWS];

} // namespace

void DebugDisplay::begin() {
  display.begin();
  display.setFont(u8g2_font_6x10_tf);
  display.setFontPosTop();
  logWindow.begin(DISPLAY_COLUMNS, DISPLAY_LOG_ROWS, logBuffer);
  logWindow.setLineHeightOffset(0);
  started_ = true;
  dirty_ = true;
}

void DebugDisplay::setStatusLine(const char *text) {
  snprintf(statusLine_, sizeof(statusLine_), "%s", text);
  dirty_ = true;
}

void DebugDisplay::appendLine(const char *text) {
  logWindow.print(text);
  logWindow.print('\n');
  dirty_ = true;
}

void DebugDisplay::setSuspended(bool suspended) { suspended_ = suspended; }

void DebugDisplay::poll(uint32_t nowMillis) {
  if (!started_ || !dirty_ || suspended_ ||
      nowMillis - lastRedrawMillis_ < DISPLAY_REFRESH_INTERVAL_MS) {
    return;
  }
  lastRedrawMillis_ = nowMillis;
  redraw();
}

void DebugDisplay::redraw() {
  display.clearBuffer();
  display.drawStr(0, STATUS_ROW_TOP, statusLine_);
  display.drawHLine(0, SEPARATOR_ROW, display.getDisplayWidth());
  display.drawLog(0, LOG_TOP, logWindow);
  display.sendBuffer();
  dirty_ = false;
}

} // namespace j5
