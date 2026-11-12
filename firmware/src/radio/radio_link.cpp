#include "radio_link.h"

#include <esp_timer.h>

#include "../board/board_radio.h"

namespace firmware {

// RadioLib leaves the over-current protection at 60 mA, which clips the higher power levels.
static constexpr uint8_t TRANSCEIVER_CURRENT_LIMIT_MA = 140;

static portMUX_TYPE interruptLock = portMUX_INITIALIZER_UNLOCKED;
static volatile bool interruptPending = false;
static volatile int64_t interruptMicros = 0;

static void IRAM_ATTR handleRadioInterrupt() {
  portENTER_CRITICAL_ISR(&interruptLock);
  interruptMicros = esp_timer_get_time();
  interruptPending = true;
  portEXIT_CRITICAL_ISR(&interruptLock);
}

static bool takeInterrupt(int64_t &micros) {
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

static bool isInterruptPending() {
  portENTER_CRITICAL(&interruptLock);
  bool pending = interruptPending;
  portEXIT_CRITICAL(&interruptLock);
  return pending;
}

static void discardInterrupt() {
  portENTER_CRITICAL(&interruptLock);
  interruptPending = false;
  portEXIT_CRITICAL(&interruptLock);
}

static RadioStatus statusOf(int16_t code) { return RadioStatus{code == RADIOLIB_ERR_NONE, code}; }

static int8_t transceiverPowerOf(const BoardSupport &board, const RadioSettings &settings) {
  return static_cast<int8_t>(transceiverPowerFor(board.model(), settings.transmitPowerDbm));
}

// Sets the transceiver parameter by parameter and stops at the first one it refuses. applied and
// appliedPower follow every parameter that it took, so they always describe the transceiver.
static int16_t configureTransceiver(const RadioSettings &settings, int8_t transceiverPower,
                                    RadioSettings &applied, int8_t &appliedPower) {
  BoardTransceiver &transceiver = boardTransceiver();
  transceiver.standby();
  int16_t state = transceiver.setFrequency(settings.frequencyMhz);
  if (state != RADIOLIB_ERR_NONE) {
    return state;
  }
  applied.frequencyMhz = settings.frequencyMhz;
  state = transceiver.setBandwidth(settings.bandwidthKhz);
  if (state != RADIOLIB_ERR_NONE) {
    return state;
  }
  applied.bandwidthKhz = settings.bandwidthKhz;
  state = transceiver.setSpreadingFactor(settings.spreadingFactor);
  if (state != RADIOLIB_ERR_NONE) {
    return state;
  }
  applied.spreadingFactor = settings.spreadingFactor;
  state = transceiver.setCodingRate(settings.codingRateDenominator);
  if (state != RADIOLIB_ERR_NONE) {
    return state;
  }
  applied.codingRateDenominator = settings.codingRateDenominator;
  state = transceiver.setPreambleLength(settings.preambleLength);
  if (state != RADIOLIB_ERR_NONE) {
    return state;
  }
  applied.preambleLength = settings.preambleLength;
  state = transceiver.setSyncWord(settings.syncWord);
  if (state != RADIOLIB_ERR_NONE) {
    return state;
  }
  applied.syncWord = settings.syncWord;
  state = transceiver.setOutputPower(transceiverPower);
  if (state != RADIOLIB_ERR_NONE) {
    return state;
  }
  applied.transmitPowerDbm = settings.transmitPowerDbm;
  appliedPower = transceiverPower;
  state = transceiver.setCurrentLimit(TRANSCEIVER_CURRENT_LIMIT_MA);
  if (state != RADIOLIB_ERR_NONE) {
    return state;
  }
  configureBoardLowNoiseAmplifier(settings.lowNoiseAmplifierEnabled);
  applied.lowNoiseAmplifierEnabled = settings.lowNoiseAmplifierEnabled;
  return RADIOLIB_ERR_NONE;
}

RadioStatus RadioLink::begin(const BoardSupport &board, const RadioSettings &settings) {
  board_ = &board;
  const int8_t power = transceiverPowerOf(board, settings);
  // Report the requested settings even if the transceiver fails to start.
  settings_ = settings;
  transceiverPower_ = power;

  BoardTransceiver &transceiver = boardTransceiver();
  int16_t state = beginBoardTransceiver(settings, power);
  if (state == RADIOLIB_ERR_NONE) {
    state = transceiver.setCurrentLimit(TRANSCEIVER_CURRENT_LIMIT_MA);
  }
  if (state != RADIOLIB_ERR_NONE) {
    return statusOf(state);
  }

  transceiver.setPacketReceivedAction(handleRadioInterrupt);
  return statusOf(transceiver.startReceive());
}

bool RadioLink::requestSettings(const RadioSettings &settings, SettingsResult &result) {
  if (transmitting_) {
    deferredSettings_ = settings;
    hasDeferredSettings_ = true;
    return false;
  }
  result = applySettings(settings);
  return true;
}

bool RadioLink::applyDeferredSettings(SettingsResult &result) {
  if (transmitting_ || !hasDeferredSettings_) {
    return false;
  }
  hasDeferredSettings_ = false;
  result = applySettings(deferredSettings_);
  return true;
}

SettingsResult RadioLink::applySettings(const RadioSettings &settings) {
  BoardTransceiver &transceiver = boardTransceiver();
  const RadioSettings previous = settings_;
  const int16_t applyCode = configureTransceiver(settings, transceiverPowerOf(*board_, settings),
                                                 settings_, transceiverPower_);
  if (applyCode != RADIOLIB_ERR_NONE) {
    int16_t restoreCode = configureTransceiver(previous, transceiverPowerOf(*board_, previous),
                                               settings_, transceiverPower_);
    const int16_t receiveCode = transceiver.startReceive();
    if (restoreCode == RADIOLIB_ERR_NONE) {
      restoreCode = receiveCode;
    }
    return SettingsResult{statusOf(applyCode), statusOf(restoreCode)};
  }
  return SettingsResult{statusOf(transceiver.startReceive()), statusOf(RADIOLIB_ERR_NONE)};
}

TransmitResult RadioLink::startTransmit(const uint8_t *data, size_t length) {
  if (isInterruptPending()) {
    return TransmitResult{TransmitStatus::ReceptionPending, RADIOLIB_ERR_NONE, 0,
                          statusOf(RADIOLIB_ERR_NONE)};
  }
  BoardTransceiver &transceiver = boardTransceiver();
  const int16_t state = transceiver.startTransmit(data, length);
  if (state != RADIOLIB_ERR_NONE) {
    return TransmitResult{TransmitStatus::Failed, state, 0, statusOf(transceiver.startReceive())};
  }
  const int64_t startMicros = esp_timer_get_time();
  // A reception that completed while the frame was being loaded is lost: the radio is already
  // transmitting, so its interrupt must not be taken for the end of this transmission.
  discardInterrupt();
  transmitting_ = true;
  return TransmitResult{TransmitStatus::Started, RADIOLIB_ERR_NONE, startMicros,
                        statusOf(RADIOLIB_ERR_NONE)};
}

RadioEvent RadioLink::poll(ReceivedFrame &frame, TransmitEnd &transmitEnd) {
  int64_t micros = 0;
  if (!takeInterrupt(micros)) {
    return RadioEvent::None;
  }

  BoardTransceiver &transceiver = boardTransceiver();

  if (transmitting_) {
    transmitting_ = false;
    transmitEnd.micros = micros;
    // The first failure of the two, as for the restore of a change of settings.
    int16_t state = transceiver.finishTransmit();
    const int16_t receiveState = transceiver.startReceive();
    if (state == RADIOLIB_ERR_NONE) {
      state = receiveState;
    }
    transmitEnd.reception = statusOf(state);
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
  frame.rssi = correctBoardRssi(transceiver.getRSSI(), snr);
  frame.frequencyError = transceiver.getFrequencyError();
  frame.integrityVerified = state == RADIOLIB_ERR_NONE;
  frame.receivedAtMicros = micros;
  // readData clears the interrupt flags and leaves the transceiver in continuous reception. Arming
  // the reception again here could cut the preamble of a frame sent right after this one.
  return RadioEvent::FrameReceived;
}

} // namespace firmware
