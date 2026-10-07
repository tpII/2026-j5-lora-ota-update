#include "serial_transport.h"

#include <Arduino.h>
#include <string.h>

namespace firmware {

void SerialTransport::begin(uint32_t baudRate) {
  Serial.setTxBufferSize(SERIAL_TRANSMIT_BUFFER_SIZE);
  Serial.begin(baudRate);
#if ARDUINO_USB_MODE && ARDUINO_USB_CDC_ON_BOOT
  // Native USB of the ESP32-S3: without a host reading the port, writes must not wait.
  Serial.setTxTimeoutMs(0);
#endif
}

bool SerialTransport::readLine(char *buffer, size_t capacity, bool &overflowed) {
  while (Serial.available() > 0) {
    const int character = Serial.read();
    if (character < 0) {
      break;
    }
    if (character == '\r') {
      continue;
    }
    if (character == '\n') {
      overflowed = pendingOverflowed_;
      const size_t length = pendingLength_ < capacity - 1 ? pendingLength_ : capacity - 1;
      memcpy(buffer, pending_, length);
      buffer[length] = '\0';
      pendingLength_ = 0;
      pendingOverflowed_ = false;
      return true;
    }
    if (pendingLength_ < CONSOLE_LINE_CAPACITY) {
      pending_[pendingLength_++] = static_cast<char>(character);
    } else {
      pendingOverflowed_ = true;
    }
  }
  return false;
}

bool SerialTransport::writeLine(const char *line, size_t length) {
  if (Serial.availableForWrite() < static_cast<int>(length + 1)) {
    return false;
  }
  Serial.write(reinterpret_cast<const uint8_t *>(line), length);
  Serial.write('\n');
  return true;
}

} // namespace firmware
