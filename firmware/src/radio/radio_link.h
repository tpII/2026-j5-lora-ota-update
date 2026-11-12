#ifndef J5_RADIO_LINK_H
#define J5_RADIO_LINK_H

#include <stddef.h>
#include <stdint.h>

#include "../board/board_support.h"
#include "radio_settings.h"
#include "received_frame.h"

namespace firmware {

enum class RadioEvent : uint8_t { None, TransmitDone, FrameReceived };

// How an operation of the transceiver went, with the RadioLib code that the error event reports
// when it failed.
struct RadioStatus {
  bool succeeded;
  int16_t code;
};

// ReceptionPending: a received frame waits to be read; the caller tries again after the next poll.
enum class TransmitStatus : uint8_t { Started, ReceptionPending, Failed };

struct TransmitResult {
  TransmitStatus status;
  int16_t errorCode;     // RadioLib code when Failed
  int64_t startMicros;   // when Started: the moment the transceiver started to transmit
  RadioStatus reception; // when Failed: whether the transceiver went back to reception
};

// The end of a transmission: the interrupt at its end and whether the transceiver went back to
// reception after it.
struct TransmitEnd {
  int64_t micros;
  RadioStatus reception;
};

// A change of settings. After a failed change the radio goes back to the previous settings;
// restore tells whether it could.
struct SettingsResult {
  RadioStatus apply;
  RadioStatus restore;
};

// Owns the LoRa transceiver: half-duplex, in continuous reception except while transmitting.
// Interrupts only record a timestamp; all work happens in poll().
class RadioLink {
public:
  RadioStatus begin(const BoardSupport &board, const RadioSettings &settings);

  // A change of settings. A change in the middle of a transmission would cut it, so while the
  // radio transmits the change waits for applyDeferredSettings(); otherwise it applies at once.
  // Returns true, with the result, when it applied at once.
  bool requestSettings(const RadioSettings &settings, SettingsResult &result);
  // Applies the change that waited for the end of a transmission, once the radio no longer
  // transmits. Returns true, with the result, when it applied one.
  bool applyDeferredSettings(SettingsResult &result);

  // The settings that the transceiver took, parameter by parameter: after a change that failed
  // and could not be undone, a mix of the previous and the requested ones.
  const RadioSettings &settings() const { return settings_; }
  // The settings that a change starts from: those that wait for the transmission to end, or else
  // those of the transceiver.
  const RadioSettings &requestedSettings() const {
    return hasDeferredSettings_ ? deferredSettings_ : settings_;
  }
  int8_t transceiverPower() const { return transceiverPower_; }
  bool isTransmitting() const { return transmitting_; }

  TransmitResult startTransmit(const uint8_t *data, size_t length);
  // FrameReceived fills the frame; TransmitDone fills the end of the transmission.
  RadioEvent poll(ReceivedFrame &frame, TransmitEnd &transmitEnd);

private:
  SettingsResult applySettings(const RadioSettings &settings);

  const BoardSupport *board_ = nullptr;
  RadioSettings settings_{};
  RadioSettings deferredSettings_{};
  bool hasDeferredSettings_ = false;
  int8_t transceiverPower_ = 0;
  bool transmitting_ = false;
};

} // namespace firmware

#endif
