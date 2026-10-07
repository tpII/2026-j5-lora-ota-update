#ifndef J5_ECHO_SERVICE_H
#define J5_ECHO_SERVICE_H

#include <stddef.h>
#include <stdint.h>

namespace j5 {

// One outstanding echo request at a time, and the bodies of ECHO_REQUEST and ECHO_REPLY
// (docs/protocol/frame.md).
class EchoService {
public:
  bool isPending() const { return pending_; }

  // Registers a request queued for transmission. Until it starts transmitting, a provisional
  // deadline keeps a request that never leaves from blocking further echoes.
  void prepare(uint16_t destination, uint16_t number, uint16_t size, uint32_t nowMillis);
  // Starts the real deadline: twice the time on air of the frame plus a margin.
  void markTransmitting(int64_t startMicros, uint32_t startMillis, uint32_t timeOnAirMicros);

  bool isReplyExpected(uint16_t source, uint16_t number) const;
  bool hasExpired(uint32_t nowMillis) const;
  void clear() { pending_ = false; }

  uint16_t destination() const { return destination_; }
  uint16_t number() const { return number_; }
  uint16_t size() const { return size_; }
  int64_t startMicros() const { return startMicros_; }
  uint32_t timeoutMillis() const { return timeoutMillis_; }

  static size_t encodeRequest(uint16_t number, uint16_t size, uint8_t *output);
  static size_t encodeReply(uint16_t number, float rssi, float snr, uint16_t size, uint8_t *output);
  static void decodeReplyQuality(const uint8_t *payload, float &rssi, float &snr);

private:
  bool pending_ = false;
  bool transmitting_ = false;
  uint16_t destination_ = 0;
  uint16_t number_ = 0;
  uint16_t size_ = 0;
  int64_t startMicros_ = 0;
  uint32_t startMillis_ = 0;
  uint32_t timeoutMillis_ = 0;
};

} // namespace j5

#endif
