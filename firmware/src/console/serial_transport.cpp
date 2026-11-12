#include "serial_transport.h"

#include <Arduino.h>
#include <string.h>

#include "../board/board_support.h"
#include "command_line.h"
#include "event_sink.h"

namespace firmware {

// writeLine drops a line that does not fit the free buffer, so the buffer holds the longest event
// and as much again for the lines that queue behind it.
static constexpr size_t SERIAL_TRANSMIT_BUFFER_SIZE = 2 * EVENT_LINE_CAPACITY;
static constexpr size_t SERIAL_RECEIVE_BUFFER_SIZE = MAXIMUM_COMMAND_LINE_LENGTH + 256;

void SerialTransport::begin(uint32_t baudRate) {
  Serial.setTxBufferSize(SERIAL_TRANSMIT_BUFFER_SIZE);
  // The longest line, a load_image with a whole image, has to fit while the main loop is busy, for
  // example redrawing the display: at CONSOLE_BAUD_RATE it arrives in about 24 ms.
  Serial.setRxBufferSize(SERIAL_RECEIVE_BUFFER_SIZE);
  Serial.begin(baudRate);
  configureConsoleSerial();
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
    if (pendingLength_ < MAXIMUM_COMMAND_LINE_LENGTH) {
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
