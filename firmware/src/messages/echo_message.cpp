#include "echo_message.h"

#include <string.h>

#include "../encoding/byte_order.h"
#include "link_quality.h"

namespace firmware {

static_assert(MINIMUM_ECHO_SIZE >= ECHO_REPLY_FIELDS_SIZE,
              "every echo the console accepts can be answered with the same length");

size_t encodeEchoRequest(const EchoRequestMessage &message, uint8_t *output) {
  memset(output, 0, message.size);
  writeUint16(output + ECHO_NUMBER_OFFSET, message.number);
  return message.size;
}

size_t encodeEchoReply(const EchoReplyMessage &message, uint8_t *output) {
  memset(output, 0, message.size);
  writeUint16(output + ECHO_NUMBER_OFFSET, message.number);
  output[ECHO_RSSI_OFFSET] = encodeRssi(message.rssi);
  output[ECHO_SNR_OFFSET] = encodeSnr(message.snr);
  return message.size;
}

bool decodeEchoRequest(const uint8_t *payload, size_t length, EchoRequestMessage &message) {
  if (length < ECHO_REPLY_FIELDS_SIZE) {
    return false;
  }
  message.number = readUint16(payload + ECHO_NUMBER_OFFSET);
  message.size = static_cast<uint16_t>(length);
  return true;
}

bool decodeEchoReply(const uint8_t *payload, size_t length, EchoReplyMessage &message) {
  if (length < ECHO_REPLY_FIELDS_SIZE) {
    return false;
  }
  message.number = readUint16(payload + ECHO_NUMBER_OFFSET);
  message.rssi = decodeRssi(payload[ECHO_RSSI_OFFSET]);
  message.snr = decodeSnr(payload[ECHO_SNR_OFFSET]);
  message.size = static_cast<uint16_t>(length);
  return true;
}

} // namespace firmware
