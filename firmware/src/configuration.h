#ifndef J5_CONFIGURATION_H
#define J5_CONFIGURATION_H

#include <stddef.h>
#include <stdint.h>

#include "image/image_format.h"

// Secrets are compiled into the firmware. To use other values, create firmware/build_opt.h (ignored
// by git) with one option per line, for example: -DJ5_NETWORK_KEY="\"another key\""
#ifndef J5_NETWORK_KEY
#define J5_NETWORK_KEY "bichofeo"
#endif

#ifndef J5_ACCESS_POINT_PASSWORD
#define J5_ACCESS_POINT_PASSWORD "bichofeo"
#endif

// Ed25519 public key of the operator, as 64 hexadecimal digits (docs/protocol/image.md). The
// default one belongs to the development key pair in keys/default_operator_key.pem.
#ifndef J5_OPERATOR_PUBLIC_KEY
#define J5_OPERATOR_PUBLIC_KEY "9b82c16539e90d39d9f1a1f786f30c123d8292453b88bdd271c412230940b573"
#endif

namespace firmware {

constexpr const char *FIRMWARE_VERSION = "0.2.0";
constexpr uint8_t PROTOCOL_VERSION = 2;
constexpr const char *DEFAULT_NETWORK_KEY = "bichofeo";
constexpr const char *DEFAULT_OPERATOR_PUBLIC_KEY =
    "9b82c16539e90d39d9f1a1f786f30c123d8292453b88bdd271c412230940b573";

constexpr uint32_t CONSOLE_BAUD_RATE = 921600;
constexpr size_t CONSOLE_LINE_CAPACITY = 200;
// Only load_image may be longer: it carries a whole image as two hexadecimal digits per byte.
constexpr size_t IMAGE_LINE_CAPACITY = 2 * MAXIMUM_IMAGE_SIZE + 32;
// The longest event is program, with the whole program as two hexadecimal digits per byte.
constexpr size_t EVENT_LINE_CAPACITY = 2 * PROGRAM_CAPACITY + 256;
constexpr size_t SERIAL_TRANSMIT_BUFFER_SIZE = 4096;
constexpr size_t SERIAL_RECEIVE_BUFFER_SIZE = IMAGE_LINE_CAPACITY + 256;

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
constexpr size_t BURST_QUEUE_CAPACITY = 4;

constexpr uint16_t MINIMUM_ECHO_SIZE = 4;
constexpr uint16_t MINIMUM_TEST_SIZE = 8;
constexpr uint32_t MAXIMUM_RUN_INTERVAL_MS = 60000;
constexpr uint32_t RESPONSE_MARGIN_MS = 1000;
// Added to the burst end and to the report repeat deadlines (docs/protocol/frame.md).
constexpr uint32_t TRANSFER_MARGIN_MS = 500;

constexpr uint32_t DISPLAY_REFRESH_INTERVAL_MS = 200;

constexpr uint32_t VM_TICK_PERIOD_MS = 10000;
constexpr uint32_t VM_INSTRUCTIONS_PER_POLL = 64;
constexpr uint32_t VM_MAXIMUM_INSTRUCTIONS_PER_TICK = 10000;

} // namespace firmware

#endif
