#ifndef J5_RADIO_LINK_H
#define J5_RADIO_LINK_H

#include <stddef.h>
#include <stdint.h>

#include "../board/board_support.h"
#include "../network/frame.h"
#include "radio_settings.h"

namespace j5 {

// Returned by startTransmit when a received frame is waiting to be read; the caller retries
// after the next poll.
constexpr int16_t RADIO_LINK_RECEPTION_PENDING = 1;

struct ReceivedFrame {
  uint8_t data[MAXIMUM_FRAME_SIZE];
  size_t length;
  float rssi;
  float snr;
  float frequencyError;
  bool integrityVerified;
  int64_t receivedAtMicros;
};

enum class RadioEvent : uint8_t { None, TransmitDone, FrameReceived };

// Owns the LoRa transceiver: half-duplex, in continuous reception except while transmitting.
// Interrupts only record a timestamp; all work happens in poll().
class RadioLink {
public:
  int16_t begin(const BoardSupport &board, const RadioSettings &settings);
  int16_t applySettings(const RadioSettings &settings);

  const RadioSettings &settings() const { return settings_; }
  int8_t transceiverPower() const { return transceiverPower_; }
  bool isTransmitting() const { return transmitting_; }

  int16_t startTransmit(const uint8_t *data, size_t length);
  RadioEvent poll(ReceivedFrame &frame);

  int64_t transmitStartMicros() const { return transmitStartMicros_; }
  uint32_t measuredTimeOnAirMicros() const { return measuredTimeOnAirMicros_; }

private:
  int16_t configureTransceiver(const RadioSettings &settings, int8_t transceiverPower);
  void configureLowNoiseAmplifier(bool enabled);
  float correctRssi(float rssi, float snr) const;

  const BoardSupport *board_ = nullptr;
  RadioSettings settings_{};
  int8_t transceiverPower_ = 0;
  bool transmitting_ = false;
  int64_t transmitStartMicros_ = 0;
  uint32_t measuredTimeOnAirMicros_ = 0;
};

} // namespace j5

#endif
