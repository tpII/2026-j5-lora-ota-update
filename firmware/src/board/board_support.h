#ifndef J5_BOARD_SUPPORT_H
#define J5_BOARD_SUPPORT_H

#include "../protocol/protocol_contract.h"

// The board model is chosen at compile time by the Arduino board selected for the build
// (docs/adrs/0001-mixed-heltec-v2-and-v4-3-boards.md). Each model has its own source file in this
// directory, compiled only for that model: heltec_v2.cpp and heltec_v4_3.cpp.
#if defined(ARDUINO_HELTEC_WIFI_LORA_32_V2)
#define J5_BOARD_HELTEC_V2 1
#elif defined(ARDUINO_HELTEC_WIFI_LORA_32_V4)
#define J5_BOARD_HELTEC_V4_3 1
#else
#error "Unsupported board: select Heltec WiFi LoRa 32(V2) or Heltec WiFi LoRa 32(V4)."
#endif

namespace firmware {

class BoardSupport {
public:
  // Powers the display and the radio path. Must run before the radio and the display start.
  void begin();

  BoardModel model() const;
  const char *modelName() const { return boardModelName(model()); }

  // True when the V4.3 front end answered as a KCT8103L; always true on the V2.
  bool isFrontEndVerified() const { return frontEndVerified_; }

private:
  bool frontEndVerified_ = false;
};

// Adapts the console serial port to the USB of the board, once Serial.begin() has run.
void configureConsoleSerial();

} // namespace firmware

#endif
