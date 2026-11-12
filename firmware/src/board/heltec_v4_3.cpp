// Heltec WiFi LoRa 32 V4.3: ESP32-S3, SX1262 and KCT8103L front end.

#include "board_support.h"

#if J5_BOARD_HELTEC_V4_3

#include <Arduino.h>
#include <SPI.h>

#include "board_radio.h"

namespace firmware {

// The V4.3 schematic drives a P-MOSFET gate with Vext (LOW = on); the datasheet text says the
// opposite, and the bench has not settled it yet (firmware/README.md, "Notas de hardware").
static constexpr uint8_t EXTERNAL_POWER_ON_LEVEL = LOW;
static constexpr uint32_t EXTERNAL_POWER_SETTLING_DELAY_MS = 50;
static constexpr uint32_t FRONT_END_POWER_UP_DELAY_MS = 5;

// Pins of the KCT8103L front end, taken from the Heltec schematic. CTX is set high by
// BoardSupport::begin() and then driven by the RF switch table of the transceiver.
static constexpr uint8_t FRONT_END_POWER_PIN = 7;    // LDO of the front end, active high
static constexpr uint8_t FRONT_END_ENABLE_PIN = 2;   // CSD, active high
static constexpr uint8_t FRONT_END_TRANSMIT_PIN = 5; // CTX: high to transmit or to bypass the LNA

static constexpr float TCXO_VOLTAGE = 1.8f;

static const SPISettings transceiverSpiSettings(TRANSCEIVER_SPI_FREQUENCY_HZ, MSBFIRST, SPI_MODE0);
// The core names the SX1262 DIO1 line of the V4 "DIO0".
static Module radioModule(SS, DIO0, RST_LoRa, BUSY_LoRa, SPI, transceiverSpiSettings);
static SX1262 transceiver(&radioModule);

// CTX of the KCT8103L follows the radio mode; CPS is driven by DIO2 (high only while
// transmitting). With CTX low in reception the LNA is in the path; with CTX high it is bypassed.
static const uint32_t frontEndPins[Module::RFSWITCH_MAX_PINS] = {
    FRONT_END_TRANSMIT_PIN, RADIOLIB_NC, RADIOLIB_NC, RADIOLIB_NC, RADIOLIB_NC};
static const Module::RfSwitchMode_t lowNoiseAmplifierTable[] = {
    {Module::MODE_IDLE, {LOW}},
    {Module::MODE_RX, {LOW}},
    {Module::MODE_TX, {HIGH}},
    END_OF_MODE_TABLE,
};
static const Module::RfSwitchMode_t bypassTable[] = {
    {Module::MODE_IDLE, {HIGH}},
    {Module::MODE_RX, {HIGH}},
    {Module::MODE_TX, {HIGH}},
    END_OF_MODE_TABLE,
};

void BoardSupport::begin() {
  pinMode(Vext, OUTPUT);
  digitalWrite(Vext, EXTERNAL_POWER_ON_LEVEL);
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
  delay(EXTERNAL_POWER_SETTLING_DELAY_MS);
}

BoardModel BoardSupport::model() const { return BoardModel::HeltecV43; }

void configureConsoleSerial() {
#if ARDUINO_USB_MODE && ARDUINO_USB_CDC_ON_BOOT
  // Native USB of the ESP32-S3: without a host reading the port, writes must not wait.
  Serial.setTxTimeoutMs(0);
#endif
}

BoardTransceiver &boardTransceiver() { return transceiver; }

int16_t beginBoardTransceiver(const RadioSettings &settings, int8_t transceiverPower) {
  SPI.begin(SCK, MISO, MOSI, SS);
  configureBoardLowNoiseAmplifier(settings.lowNoiseAmplifierEnabled);
  int16_t state =
      transceiver.begin(settings.frequencyMhz, settings.bandwidthKhz, settings.spreadingFactor,
                        settings.codingRateDenominator, settings.syncWord, transceiverPower,
                        settings.preambleLength, TCXO_VOLTAGE, false);
  if (state != RADIOLIB_ERR_NONE) {
    return state;
  }
  state = transceiver.setDio2AsRfSwitch(true);
  if (state == RADIOLIB_ERR_NONE) {
    state = transceiver.setRxBoostedGainMode(true);
  }
  if (state == RADIOLIB_ERR_NONE) {
    state = transceiver.setCRC(2);
  }
  if (state == RADIOLIB_ERR_NONE) {
    // Keep the TCXO running in standby and after each transmission or reception. With the default
    // RC standby, every switch from transmission to reception waits about 5 ms for the TCXO,
    // longer than the 3.1 ms preamble at SF7 and 500 kHz: a node that sent an echo request was not
    // yet listening when the reply started.
    state = transceiver.setStandbyXOSC(true);
  }
  return state;
}

void configureBoardLowNoiseAmplifier(bool enabled) {
  transceiver.setRfSwitchTable(frontEndPins, enabled ? lowNoiseAmplifierTable : bypassTable);
}

float correctBoardRssi(float rssi, float snr) {
  (void)snr;
  return rssi;
}

} // namespace firmware

#endif
