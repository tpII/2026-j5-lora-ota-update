#include "time_on_air.h"

#include <math.h>

namespace j5 {

namespace {

// Low data rate optimization is mandatory when a symbol lasts 16 ms or more: SF11 and SF12 at
// 125 kHz and SF12 at 250 kHz. RadioLib enables it with the same rule.
constexpr double LOW_DATA_RATE_SYMBOL_MICROS = 16000.0;

} // namespace

uint32_t computeTimeOnAirMicros(size_t frameLength, const RadioSettings &settings) {
  const double symbolMicros =
      static_cast<double>(1UL << settings.spreadingFactor) * 1000.0 / settings.bandwidthKhz;
  const int lowDataRate = symbolMicros >= LOW_DATA_RATE_SYMBOL_MICROS ? 1 : 0;
  const int codingRate = settings.codingRateDenominator - 4;
  const int crc = 1;
  const int implicitHeader = 0;

  const double numerator = 8.0 * static_cast<double>(frameLength) - 4.0 * settings.spreadingFactor +
                           28.0 + 16.0 * crc - 20.0 * implicitHeader;
  const double denominator = 4.0 * (settings.spreadingFactor - 2 * lowDataRate);
  double payloadSymbols = ceil(numerator / denominator) * (codingRate + 4);
  if (payloadSymbols < 0.0) {
    payloadSymbols = 0.0;
  }
  payloadSymbols += 8.0;

  const double preambleMicros = (settings.preambleLength + 4.25) * symbolMicros;
  return static_cast<uint32_t>(lround(preambleMicros + payloadSymbols * symbolMicros));
}

} // namespace j5
