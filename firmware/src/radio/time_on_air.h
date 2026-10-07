#ifndef J5_TIME_ON_AIR_H
#define J5_TIME_ON_AIR_H

#include <stddef.h>
#include <stdint.h>

#include "radio_settings.h"

namespace j5 {

// Time on air of a LoRa frame of the given length, in microseconds, with explicit header and CRC,
// according to the Semtech formula (SX1276 datasheet 4.1.1.7, SX1262 datasheet 6.1.4). RadioLib
// rounds this value up to whole milliseconds on the SX1276, so the firmware computes it itself.
uint32_t computeTimeOnAirMicros(size_t frameLength, const RadioSettings &settings);

} // namespace j5

#endif
