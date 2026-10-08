#ifndef J5_EVENT_FIELDS_H
#define J5_EVENT_FIELDS_H

#include <ArduinoJson.h>
#include <stdint.h>

namespace firmware {

// Rounds a measurement to the decimals the contract asks for, so it prints without noise.
double roundToDecimals(double value, int decimals);

// Adds a node identifier to the object as four uppercase hexadecimal digits, for example "3A7F".
void setNodeId(JsonObject object, const char *key, uint16_t id);

} // namespace firmware

#endif
