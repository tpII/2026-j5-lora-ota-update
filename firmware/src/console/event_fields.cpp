#include "event_fields.h"

#include <math.h>
#include <stdio.h>

namespace firmware {

double roundToDecimals(double value, int decimals) {
  const double scale = pow(10.0, decimals);
  return round(value * scale) / scale;
}

void setNodeId(JsonObject object, const char *key, uint16_t id) {
  char text[NODE_ID_HEXADECIMAL_DIGITS + 1];
  snprintf(text, sizeof(text), "%0*X", static_cast<int>(NODE_ID_HEXADECIMAL_DIGITS),
           static_cast<unsigned>(id));
  // Assigning through the object creates the member; ArduinoJson copies the text.
  object[key] = text;
}

void setOptionalNodeId(JsonObject object, const char *key, uint16_t id) {
  if (id == NO_NODE_ID) {
    object[key] = nullptr;
  } else {
    setNodeId(object, key, id);
  }
}

void setRssi(JsonObject object, const char *key, float rssi) {
  object[key] = roundToDecimals(rssi, RSSI_DECIMALS);
}

void setSnr(JsonObject object, const char *key, float snr) {
  object[key] = roundToDecimals(snr, SNR_DECIMALS);
}

void setLinkQuality(JsonObject object, float rssi, float snr) {
  setRssi(object, "rssi", rssi);
  setSnr(object, "snr", snr);
}

void setErrorFields(JsonObject event, const char *command, ErrorReason reason, const char *detail,
                    int16_t code) {
  event["cmd"] = command;
  event["reason"] = errorReasonName(reason);
  if (detail != nullptr && detail[0] != '\0') {
    event["detail"] = detail;
  }
  if (code != 0) {
    event["code"] = code;
  }
}

} // namespace firmware
