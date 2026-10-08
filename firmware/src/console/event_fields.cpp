#include "event_fields.h"

#include <math.h>
#include <stdio.h>

namespace firmware {

double roundToDecimals(double value, int decimals) {
  const double scale = pow(10.0, decimals);
  return round(value * scale) / scale;
}

void setNodeId(JsonObject object, const char *key, uint16_t id) {
  char text[5];
  snprintf(text, sizeof(text), "%04X", static_cast<unsigned>(id));
  // Assigning through the object creates the member; ArduinoJson copies the text.
  object[key] = text;
}

} // namespace firmware
