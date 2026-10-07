#ifndef J5_BOARD_SUPPORT_H
#define J5_BOARD_SUPPORT_H

#include <Arduino.h>

// The board model is chosen at compile time by the Arduino board selected for the build
// (docs/adrs/0001-mixed-heltec-v2-and-v4-3-boards.md).
#if defined(ARDUINO_HELTEC_WIFI_LORA_32_V2)
#define J5_BOARD_HELTEC_V2 1
#elif defined(ARDUINO_HELTEC_WIFI_LORA_32_V4)
#define J5_BOARD_HELTEC_V4_3 1
#else
#error "Unsupported board: select Heltec WiFi LoRa 32(V2) or Heltec WiFi LoRa 32(V4)."
#endif

namespace j5 {

enum class BoardModel : uint8_t { HeltecV2 = 1, HeltecV43 = 2 };

// Name of a board model as it appears in console events, or nullptr for an unknown value.
const char *boardModelName(uint8_t model);

// Pins of the KCT8103L front end on the V4.3, taken from the Heltec schematic.
constexpr uint8_t FRONT_END_POWER_PIN = 7;    // LDO of the front end, active high
constexpr uint8_t FRONT_END_ENABLE_PIN = 2;   // CSD, active high
constexpr uint8_t FRONT_END_TRANSMIT_PIN = 5; // CTX: high to transmit or to bypass the LNA

class BoardSupport {
public:
  // Powers the display and the radio path. Must run before the radio and the display start.
  void begin();

  BoardModel model() const;
  const char *modelName() const;
  bool hasLowNoiseAmplifier() const;

  // True when the V4.3 front end answered as a KCT8103L; always true on the V2.
  bool isFrontEndVerified() const { return frontEndVerified_; }

  // Transmit power is expressed at the antenna connector (docs/protocol/radio.md).
  bool isTransmitPowerReachable(int16_t antennaDbm) const;
  int8_t transceiverPowerFor(int8_t antennaDbm) const;
  int8_t minimumTransmitPower() const;
  const char *transmitPowerRange() const;

private:
  bool frontEndVerified_ = false;
};

} // namespace j5

#endif
