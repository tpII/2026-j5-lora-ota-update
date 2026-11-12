// Heltec WiFi LoRa 32 V2: ESP32 and SX1276.

#include "board_support.h"

#if J5_BOARD_HELTEC_V2

#include <Arduino.h>
#include <SPI.h>

#include "board_radio.h"

namespace firmware {

// Vext powers the OLED and, on revision 2.0, the PE4259 RF switch.
static constexpr uint8_t EXTERNAL_POWER_ON_LEVEL = LOW;
static constexpr uint32_t EXTERNAL_POWER_SETTLING_DELAY_MS = 50;

static const SPISettings transceiverSpiSettings(TRANSCEIVER_SPI_FREQUENCY_HZ, MSBFIRST, SPI_MODE0);
static Module radioModule(SS, DIO0, RST_LoRa, DIO1, SPI, transceiverSpiSettings);
static SX1276 transceiver(&radioModule);

void BoardSupport::begin() {
  pinMode(Vext, OUTPUT);
  digitalWrite(Vext, EXTERNAL_POWER_ON_LEVEL);
  frontEndVerified_ = true;
  delay(EXTERNAL_POWER_SETTLING_DELAY_MS);
}

BoardModel BoardSupport::model() const { return BoardModel::HeltecV2; }

void configureConsoleSerial() {}

BoardTransceiver &boardTransceiver() { return transceiver; }

int16_t beginBoardTransceiver(const RadioSettings &settings, int8_t transceiverPower) {
  SPI.begin(SCK, MISO, MOSI, SS);
  const int16_t state =
      transceiver.begin(settings.frequencyMhz, settings.bandwidthKhz, settings.spreadingFactor,
                        settings.codingRateDenominator, settings.syncWord, transceiverPower,
                        settings.preambleLength, 0);
  if (state != RADIOLIB_ERR_NONE) {
    return state;
  }
  return transceiver.setCRC(true);
}

void configureBoardLowNoiseAmplifier(bool enabled) { (void)enabled; }

float correctBoardRssi(float rssi, float snr) {
  // RadioLib reports -157 + PacketRssi on the HF port. For a positive SNR the SX1276 datasheet
  // (5.5.5) scales PacketRssi by 16/15; for a negative SNR RadioLib already adds the SNR.
  if (snr >= 0.0f) {
    const float packetRssi = rssi + 157.0f;
    return -157.0f + packetRssi * 16.0f / 15.0f;
  }
  return rssi;
}

} // namespace firmware

#endif
