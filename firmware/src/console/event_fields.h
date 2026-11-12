#ifndef J5_EVENT_FIELDS_H
#define J5_EVENT_FIELDS_H

#include <ArduinoJson.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

// Rounds a measurement to the decimals the contract asks for, so it prints without noise.
double roundToDecimals(double value, int decimals);

// Adds a node identifier to the object as NODE_ID_HEXADECIMAL_DIGITS uppercase hexadecimal digits,
// for example "3A7F".
void setNodeId(JsonObject object, const char *key, uint16_t id);
// The same for a field that may name no node: null for NO_NODE_ID.
void setOptionalNodeId(JsonObject object, const char *key, uint16_t id);

// An RSSI in dBm with RSSI_DECIMALS and an SNR in dB with SNR_DECIMALS (docs/protocol/console.md).
void setRssi(JsonObject object, const char *key, float rssi);
void setSnr(JsonObject object, const char *key, float snr);
// The fields rssi and snr of a received packet.
void setLinkQuality(JsonObject object, float rssi, float snr);

// Adds the fields of the error event that follow "t" and "ev": cmd, reason and, when present, the
// detail (neither nullptr nor empty) and the RadioLib code (not zero).
void setErrorFields(JsonObject event, const char *command, ErrorReason reason, const char *detail,
                    int16_t code);

} // namespace firmware

#endif
