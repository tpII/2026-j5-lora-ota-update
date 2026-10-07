#include "echo_service.h"

#include <string.h>

#include "../configuration.h"
#include "../network/byte_order.h"
#include "../network/link_quality.h"

namespace j5 {

namespace {

// Deadline for a request still waiting in the transmission queue.
constexpr uint32_t PROVISIONAL_TIMEOUT_MS = 60000;

} // namespace

void EchoService::prepare(uint16_t destination, uint16_t number, uint16_t size,
                          uint32_t nowMillis) {
  pending_ = true;
  transmitting_ = false;
  destination_ = destination;
  number_ = number;
  size_ = size;
  startMicros_ = 0;
  startMillis_ = nowMillis;
  timeoutMillis_ = PROVISIONAL_TIMEOUT_MS;
}

void EchoService::markTransmitting(int64_t startMicros, uint32_t startMillis,
                                   uint32_t timeOnAirMicros) {
  if (!pending_ || transmitting_) {
    return;
  }
  transmitting_ = true;
  startMicros_ = startMicros;
  startMillis_ = startMillis;
  timeoutMillis_ = 2 * ((timeOnAirMicros + 999) / 1000) + RESPONSE_MARGIN_MS;
}

bool EchoService::isReplyExpected(uint16_t source, uint16_t number) const {
  return pending_ && transmitting_ && source == destination_ && number == number_;
}

bool EchoService::hasExpired(uint32_t nowMillis) const {
  return pending_ && nowMillis - startMillis_ >= timeoutMillis_;
}

size_t EchoService::encodeRequest(uint16_t number, uint16_t size, uint8_t *output) {
  memset(output, 0, size);
  writeUint16(output, number);
  return size;
}

size_t EchoService::encodeReply(uint16_t number, float rssi, float snr, uint16_t size,
                                uint8_t *output) {
  // The reply has the same length as the request, so both directions take the same time on air.
  memset(output, 0, size);
  writeUint16(output, number);
  output[2] = encodeRssi(rssi);
  output[3] = encodeSnr(snr);
  return size;
}

void EchoService::decodeReplyQuality(const uint8_t *payload, float &rssi, float &snr) {
  rssi = decodeRssi(payload[2]);
  snr = decodeSnr(payload[3]);
}

} // namespace j5
