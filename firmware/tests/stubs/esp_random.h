// Stand-in for the ESP-IDF random number generator on the host computer.
#ifndef J5_TESTS_ESP_RANDOM_H
#define J5_TESTS_ESP_RANDOM_H

#include <stdint.h>
#include <stdlib.h>

inline uint32_t esp_random() { return static_cast<uint32_t>(rand()); }

#endif
