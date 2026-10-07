#include "radio_link.h"

#include <RadioLib.h>
#include <SPI.h>
#include <esp_timer.h>

namespace j5 {

namespace {

// RadioLib leaves the over-current protection at 60 mA, which clips the higher power levels.
constexpr uint8_t TRANSCEIVER_CURRENT_LIMIT_MA = 140;

// RadioLib defaults to 2 MHz. Both transceivers accept 8 MHz (SX1276 up to 10 MHz, SX1262 up to
// 16 MHz), which shortens the gap between frames sent back to back.
const SPISettings TRANSCEIVER_SPI_SETTINGS(8000000, MSBFIRST, SPI_MODE0);

#if J5_BOARD_HELTEC_V2
Module radioModule(SS, DIO0, RST_LoRa, DIO1, SPI, TRANSCEIVER_SPI_SETTINGS);
SX1276 transceiver(&radioModule);
#else
constexpr float TCXO_VOLTAGE = 1.8f;
// The core names the SX1262 DIO1 line of the V4 "DIO0".
Module radioModule(SS, DIO0, RST_LoRa, BUSY_LoRa, SPI, TRANSCEIVER_SPI_SETTINGS);
SX1262 transceiver(&radioModule);

// CTX of the KCT8103L follows the radio mode; CPS is driven by DIO2 (high only while
// transmitting). With CTX low in reception the LNA is in the path; with CTX high it is bypassed.
const uint32_t frontEndPins[Module::RFSWITCH_MAX_PINS] = {FRONT_END_TRANSMIT_PIN, RADIOLIB_NC,
                                                          RADIOLIB_NC, RADIOLIB_NC, RADIOLIB_NC};
const Module::RfSwitchMode_t lowNoiseAmplifierTable[] = {
    {Module::MODE_IDLE, {LOW}},
    {Module::MODE_RX, {LOW}},
    {Module::MODE_TX, {HIGH}},
    END_OF_MODE_TABLE,
};
const Module::RfSwitchMode_t bypassTable[] = {
    {Module::MODE_IDLE, {HIGH}},
    {Module::MODE_RX, {HIGH}},
    {Module::MODE_TX, {HIGH}},
    END_OF_MODE_TABLE,
};
#endif

portMUX_TYPE interruptLock = portMUX_INITIALIZER_UNLOCKED;
volatile bool interruptPending = false;
volatile int64_t interruptMicros = 0;

void IRAM_ATTR handleRadioInterrupt() {
  portENTER_CRITICAL_ISR(&interruptLock);
  interruptMicros = esp_timer_get_time();
  interruptPending = true;
  portEXIT_CRITICAL_ISR(&interruptLock);
}

bool takeInterrupt(int64_t &micros) {
  bool pending = false;
  portENTER_CRITICAL(&interruptLock);
  if (interruptPending) {
    pending = true;
    micros = interruptMicros;
    interruptPending = false;
  }
  portEXIT_CRITICAL(&interruptLock);
  return pending;
}

bool isInterruptPending() {
  portENTER_CRITICAL(&interruptLock);
  bool pending = interruptPending;
  portEXIT_CRITICAL(&interruptLock);
  return pending;
}

void discardInterrupt() {
  portENTER_CRITICAL(&interruptLock);
  interruptPending = false;
  portEXIT_CRITICAL(&interruptLock);
}

} // namespace

int16_t RadioLink::begin(const BoardSupport &board, const RadioSettings &settings) {
  board_ = &board;
  SPI.begin(SCK, MISO, MOSI, SS);
  const int8_t power = board.transceiverPowerFor(settings.transmitPowerDbm);
  // Report the requested settings even if the transceiver fails to start.
  settings_ = settings;
  transceiverPower_ = power;

#if J5_BOARD_HELTEC_V2
  int16_t state = transceiver.begin(settings.frequencyMhz, settings.bandwidthKhz,
                                    settings.spreadingFactor, settings.codingRateDenominator,
                                    settings.syncWord, power, settings.preambleLength, 0);
  if (state != RADIOLIB_ERR_NONE) {
    return state;
  }
  state = transceiver.setCRC(true);
#else
  configureLowNoiseAmplifier(settings.lowNoiseAmplifierEnabled);
  int16_t state =
      transceiver.begin(settings.frequencyMhz, settings.bandwidthKhz, settings.spreadingFactor,
                        settings.codingRateDenominator, settings.syncWord, power,
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
#endif
  if (state == RADIOLIB_ERR_NONE) {
    state = transceiver.setCurrentLimit(TRANSCEIVER_CURRENT_LIMIT_MA);
  }
  if (state != RADIOLIB_ERR_NONE) {
    return state;
  }

  transceiver.setPacketReceivedAction(handleRadioInterrupt);
  return transceiver.startReceive();
}

int16_t RadioLink::applySettings(const RadioSettings &settings) {
  const int8_t power = board_->transceiverPowerFor(settings.transmitPowerDbm);
  int16_t state = configureTransceiver(settings, power);
  if (state != RADIOLIB_ERR_NONE) {
    // Best effort to leave the radio as it was before the failed change.
    configureTransceiver(settings_, transceiverPower_);
    transceiver.startReceive();
    return state;
  }
  settings_ = settings;
  transceiverPower_ = power;
  return transceiver.startReceive();
}

int16_t RadioLink::configureTransceiver(const RadioSettings &settings, int8_t transceiverPower) {
  transceiver.standby();
  int16_t state = transceiver.setFrequency(settings.frequencyMhz);
  if (state == RADIOLIB_ERR_NONE) {
    state = transceiver.setBandwidth(settings.bandwidthKhz);
  }
  if (state == RADIOLIB_ERR_NONE) {
    state = transceiver.setSpreadingFactor(settings.spreadingFactor);
  }
  if (state == RADIOLIB_ERR_NONE) {
    state = transceiver.setCodingRate(settings.codingRateDenominator);
  }
  if (state == RADIOLIB_ERR_NONE) {
    state = transceiver.setPreambleLength(settings.preambleLength);
  }
  if (state == RADIOLIB_ERR_NONE) {
    state = transceiver.setSyncWord(settings.syncWord);
  }
  if (state == RADIOLIB_ERR_NONE) {
    state = transceiver.setOutputPower(transceiverPower);
  }
  if (state == RADIOLIB_ERR_NONE) {
    state = transceiver.setCurrentLimit(TRANSCEIVER_CURRENT_LIMIT_MA);
  }
  if (state == RADIOLIB_ERR_NONE) {
    configureLowNoiseAmplifier(settings.lowNoiseAmplifierEnabled);
  }
  return state;
}

void RadioLink::configureLowNoiseAmplifier(bool enabled) {
#if J5_BOARD_HELTEC_V4_3
  transceiver.setRfSwitchTable(frontEndPins, enabled ? lowNoiseAmplifierTable : bypassTable);
#else
  (void)enabled;
#endif
}

int16_t RadioLink::startTransmit(const uint8_t *data, size_t length) {
  if (isInterruptPending()) {
    return RADIO_LINK_RECEPTION_PENDING;
  }
  int16_t state = transceiver.startTransmit(data, length);
  if (state != RADIOLIB_ERR_NONE) {
    transceiver.startReceive();
    return state;
  }
  transmitStartMicros_ = esp_timer_get_time();
  // A reception that completed while the frame was being loaded is lost: the radio is already
  // transmitting, so its interrupt must not be taken for the end of this transmission.
  discardInterrupt();
  transmitting_ = true;
  return RADIOLIB_ERR_NONE;
}

RadioEvent RadioLink::poll(ReceivedFrame &frame) {
  int64_t micros = 0;
  if (!takeInterrupt(micros)) {
    return RadioEvent::None;
  }

  if (transmitting_) {
    transmitting_ = false;
    measuredTimeOnAirMicros_ = static_cast<uint32_t>(micros - transmitStartMicros_);
    transceiver.finishTransmit();
    transceiver.startReceive();
    return RadioEvent::TransmitDone;
  }

  size_t length = transceiver.getPacketLength();
  if (length > MAXIMUM_FRAME_SIZE) {
    length = MAXIMUM_FRAME_SIZE;
  }
  const int16_t state = transceiver.readData(frame.data, length);
  const float snr = transceiver.getSNR();
  frame.length = length;
  frame.snr = snr;
  frame.rssi = correctRssi(transceiver.getRSSI(), snr);
  frame.frequencyError = transceiver.getFrequencyError();
  frame.integrityVerified = state == RADIOLIB_ERR_NONE;
  frame.receivedAtMicros = micros;
  // readData clears the interrupt flags and leaves the transceiver in continuous reception. Arming
  // the reception again here could cut the preamble of a frame sent right after this one.
  return RadioEvent::FrameReceived;
}

float RadioLink::correctRssi(float rssi, float snr) const {
#if J5_BOARD_HELTEC_V2
  // RadioLib reports -157 + PacketRssi on the HF port. For a positive SNR the SX1276 datasheet
  // (5.5.5) scales PacketRssi by 16/15; for a negative SNR RadioLib already adds the SNR.
  if (snr >= 0.0f) {
    const float packetRssi = rssi + 157.0f;
    return -157.0f + packetRssi * 16.0f / 15.0f;
  }
  return rssi;
#else
  (void)snr;
  return rssi;
#endif
}

} // namespace j5
