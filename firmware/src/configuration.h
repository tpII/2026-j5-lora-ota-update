#ifndef J5_CONFIGURATION_H
#define J5_CONFIGURATION_H

#include <stddef.h>
#include <stdint.h>

// Secrets are compiled into the firmware. To use other values, create firmware/build_opt.h (ignored
// by git) with one option per line, for example: -DJ5_NETWORK_KEY="\"another key\""
#ifndef J5_NETWORK_KEY
#define J5_NETWORK_KEY "bichofeo"
#endif

#ifndef J5_ACCESS_POINT_PASSWORD
#define J5_ACCESS_POINT_PASSWORD "bichofeo"
#endif

namespace firmware {

constexpr const char *FIRMWARE_VERSION = "0.1.0";
constexpr uint8_t PROTOCOL_VERSION = 1;
constexpr const char *DEFAULT_NETWORK_KEY = "bichofeo";

constexpr uint32_t CONSOLE_BAUD_RATE = 921600;
constexpr size_t CONSOLE_LINE_CAPACITY = 200;
constexpr size_t SERIAL_TRANSMIT_BUFFER_SIZE = 4096;

constexpr uint8_t ACCESS_POINT_CHANNEL = 1;
constexpr uint8_t ACCESS_POINT_MAXIMUM_CLIENTS = 4;

constexpr uint32_t HELLO_PERIOD_MS = 10000;
constexpr uint32_t HELLO_JITTER_MS = 2000;
constexpr uint32_t FIRST_HELLO_MINIMUM_DELAY_MS = 1000;
constexpr uint32_t FIRST_HELLO_MAXIMUM_DELAY_MS = 3000;
constexpr uint32_t NEIGHBOR_EXPIRY_MS = 60000;
constexpr uint32_t MAXIMUM_PRESENCE_HOLD_S = 3600;

constexpr size_t MAXIMUM_NEIGHBORS = 16;
constexpr size_t MAXIMUM_TRACKED_SOURCES = 16;
constexpr size_t MAXIMUM_RECEIVER_RUNS = 4;
constexpr size_t TRANSMIT_QUEUE_CAPACITY = 4;

constexpr uint16_t MINIMUM_ECHO_SIZE = 4;
constexpr uint16_t MINIMUM_TEST_SIZE = 8;
constexpr uint32_t MAXIMUM_RUN_INTERVAL_MS = 60000;
constexpr uint32_t RESPONSE_MARGIN_MS = 1000;

constexpr uint32_t DISPLAY_REFRESH_INTERVAL_MS = 200;

} // namespace firmware

#endif
