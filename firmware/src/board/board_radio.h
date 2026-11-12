#ifndef J5_BOARD_RADIO_H
#define J5_BOARD_RADIO_H

#include <RadioLib.h>
#include <stdint.h>

#include "../radio/radio_settings.h"
#include "board_support.h"

namespace firmware {

// The LoRa transceiver of each board model, for radio_link.cpp: the transceiver and its pins, the
// begin sequence, the LNA of the front end and the RSSI correction.

#if J5_BOARD_HELTEC_V2
using BoardTransceiver = SX1276;
#elif J5_BOARD_HELTEC_V4_3
using BoardTransceiver = SX1262;
#endif

// RadioLib defaults to 2 MHz. Both transceivers accept 8 MHz (SX1276 up to 10 MHz, SX1262 up to
// 16 MHz), which shortens the gap between frames sent back to back.
constexpr uint32_t TRANSCEIVER_SPI_FREQUENCY_HZ = 8000000;

BoardTransceiver &boardTransceiver();

// Starts the SPI bus and the transceiver with the settings, as the board model requires. The radio
// link then sets the current limit and starts the reception.
int16_t beginBoardTransceiver(const RadioSettings &settings, int8_t transceiverPower);

// Puts the LNA of the front end in the reception path or bypasses it; nothing on a board without
// one.
void configureBoardLowNoiseAmplifier(bool enabled);

// The RSSI of a received frame, corrected for how RadioLib computes it on the transceiver of the
// board.
float correctBoardRssi(float rssi, float snr);

} // namespace firmware

#endif
