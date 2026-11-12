// Host tests of the fields of the events.

#include <ArduinoJson.h>
#include <cstring>

#include "console/event_fields.h"
#include "host_test_harness.h"

using namespace firmware;

J5_HOST_TEST(testEventFields) {
  // setNodeId has to create the member, also inside nested objects, and round values print clean.
  JsonDocument document;
  JsonObject event = document.to<JsonObject>();
  event["ev"] = "hello";
  setNodeId(event, "src", 0xD6D8);
  setLinkQuality(event, -35.53f, 9.1f);
  JsonObject neighbor = event["neighbors"].to<JsonArray>().add<JsonObject>();
  setNodeId(neighbor, "id", 0x00F4);
  setSnr(neighbor, "snr", 2.3333f);
  setRssi(event, "rssi_avg", -70.06f);
  char line[160];
  serializeJson(document, line, sizeof(line));
  CHECK(std::strcmp(line, "{\"ev\":\"hello\",\"src\":\"D6D8\",\"rssi\":-35.5,\"snr\":9.1,"
                          "\"neighbors\":[{\"id\":\"00F4\",\"snr\":2.33}],"
                          "\"rssi_avg\":-70.1}") == 0);
}
