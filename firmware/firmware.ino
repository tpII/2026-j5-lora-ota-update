// J5 LoRa OTA Update: firmware of a node, for Heltec WiFi LoRa 32 V2 and V4.3.
// Build profiles and board options are in sketch.yaml; see README.md.

#include "src/application/node_application.h"

firmware::NodeApplication application;

void setup() { application.begin(); }

void loop() { application.poll(); }
