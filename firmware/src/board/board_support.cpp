#include "board_support.h"

namespace firmware {

#if J5_BOARD_HELTEC_V2
// Vext powers the OLED and, on revision 2.0, the PE4259 RF switch.
static constexpr uint8_t EXTERNAL_POWER_ON_LEVEL = LOW;
#else
// The V4.3 schematic drives a P-MOSFET gate with Vext (LOW = on); the datasheet text says the
// opposite. Verify on the bench: if the OLED stays dark, change this level to HIGH.
static constexpr uint8_t EXTERNAL_POWER_ON_LEVEL = LOW;
static constexpr uint32_t FRONT_END_POWER_UP_DELAY_MS = 5;
#endif

static constexpr uint32_t EXTERNAL_POWER_SETTLING_DELAY_MS = 50;

const char *boardModelName(uint8_t model) {
  switch (static_cast<BoardModel>(model)) {
  case BoardModel::HeltecV2:
    return "V2";
  case BoardModel::HeltecV43:
    return "V4.3";
  }
  return nullptr;
}

void BoardSupport::begin() {
  pinMode(Vext, OUTPUT);
  digitalWrite(Vext, EXTERNAL_POWER_ON_LEVEL);
#if J5_BOARD_HELTEC_V2
  frontEndVerified_ = true;
#else
  // Power the front end first. With its LDO on, CSD reads high when a KCT8103L is fitted; the
  // GC1109 of earlier revisions pulls it low.
  pinMode(FRONT_END_POWER_PIN, OUTPUT);
  digitalWrite(FRONT_END_POWER_PIN, HIGH);
  delay(FRONT_END_POWER_UP_DELAY_MS);
  pinMode(FRONT_END_ENABLE_PIN, INPUT);
  frontEndVerified_ = digitalRead(FRONT_END_ENABLE_PIN) == HIGH;
  pinMode(FRONT_END_ENABLE_PIN, OUTPUT);
  digitalWrite(FRONT_END_ENABLE_PIN, HIGH);
  pinMode(FRONT_END_TRANSMIT_PIN, OUTPUT);
  digitalWrite(FRONT_END_TRANSMIT_PIN, HIGH);
#endif
  delay(EXTERNAL_POWER_SETTLING_DELAY_MS);
}

BoardModel BoardSupport::model() const {
#if J5_BOARD_HELTEC_V2
  return BoardModel::HeltecV2;
#else
  return BoardModel::HeltecV43;
#endif
}

const char *BoardSupport::modelName() const {
  return boardModelName(static_cast<uint8_t>(model()));
}

bool BoardSupport::hasLowNoiseAmplifier() const {
#if J5_BOARD_HELTEC_V2
  return false;
#else
  return true;
#endif
}

bool BoardSupport::isTransmitPowerReachable(int16_t antennaDbm) const {
#if J5_BOARD_HELTEC_V2
  // PA_BOOST output: RadioLib accepts 2 to 17 dBm or exactly 20 dBm.
  return (antennaDbm >= 2 && antennaDbm <= 17) || antennaDbm == 20;
#else
  return antennaDbm >= 4 && antennaDbm <= 28;
#endif
}

int8_t BoardSupport::transceiverPowerFor(int8_t antennaDbm) const {
#if J5_BOARD_HELTEC_V2
  return antennaDbm;
#else
  // Gain of the KCT8103L for each SX1262 setting: 13 dB up to 13 dBm, 12 dB at 14 and 15 dBm,
  // 11 dB at 16 and 17 dBm. The antenna power stops rising at 28 dBm.
  if (antennaDbm <= 26) {
    return static_cast<int8_t>(antennaDbm - 13);
  }
  if (antennaDbm == 27) {
    return 15;
  }
  return 17;
#endif
}

int8_t BoardSupport::minimumTransmitPower() const {
#if J5_BOARD_HELTEC_V2
  return 2;
#else
  return 4;
#endif
}

const char *BoardSupport::transmitPowerRange() const {
#if J5_BOARD_HELTEC_V2
  return "power 2..17 or 20 on V2";
#else
  return "power 4..28 on V4.3";
#endif
}

} // namespace firmware
