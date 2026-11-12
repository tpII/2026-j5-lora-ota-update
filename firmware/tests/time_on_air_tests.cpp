// Host tests of the time on air.

#include <math.h>

#include "generated_test_vectors.h"
#include "host_test_harness.h"
#include "radio/time_on_air.h"

using namespace firmware;

J5_HOST_TEST(testTimeOnAir) {
  // The reference cases that the control panel checks too, with explicit header and CRC. The
  // reference value in milliseconds has one decimal.
  for (const TimeOnAirVector &reference : TIME_ON_AIR_VECTORS) {
    RadioSettings settings = defaultRadioSettings();
    settings.spreadingFactor = reference.spreadingFactor;
    settings.bandwidthKhz = reference.bandwidthKhz;
    settings.codingRateDenominator = reference.codingRateDenominator;
    settings.preambleLength = reference.preambleLength;
    const uint32_t micros = computeTimeOnAirMicros(reference.frameLength, settings);
    CHECK(micros == reference.expectedMicros);
    CHECK(fabs(micros / 1000.0 - reference.expectedMillis) < 0.05);
  }
}
