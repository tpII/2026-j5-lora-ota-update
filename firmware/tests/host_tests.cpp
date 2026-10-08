// Host tests of the hardware-independent firmware modules. Run them with run_host_tests.sh.

#include <ArduinoJson.h>
#include <cmath>
#include <cstdio>
#include <cstring>

#include "console/event_fields.h"
#include "network/duplicate_filter.h"
#include "radio/time_on_air.h"
#include "services/echo_service.h"
#include "services/presence_service.h"
#include "services/test_run_service.h"

using namespace firmware;

static int failureCount = 0;

static void check(bool condition, const char *description, int line) {
  if (!condition) {
    std::printf("FAIL (line %d): %s\n", line, description);
    ++failureCount;
  }
}

#define CHECK(condition) check((condition), #condition, __LINE__)

static void testTimeOnAir() {
  // Reference values at 125 kHz, CR 4/5, preamble of 8 symbols, explicit header and CRC.
  struct ReferenceCase {
    size_t frameLength;
    uint8_t spreadingFactor;
    double expectedMillis;
  };
  const ReferenceCase cases[] = {{33, 7, 71.9},  {33, 9, 246.8},  {33, 12, 1810.4},
                                 {81, 7, 143.6}, {255, 7, 399.6}, {255, 12, 9019.4}};
  for (const ReferenceCase &reference : cases) {
    const RadioSettings settings{915.9f, reference.spreadingFactor, 125, 5, 8, 0x12, 4, false};
    const double millis = computeTimeOnAirMicros(reference.frameLength, settings) / 1000.0;
    CHECK(std::fabs(millis - reference.expectedMillis) < 0.06);
  }
}

static void testDuplicateFilter() {
  DuplicateFilter filter;
  CHECK(filter.acceptIfNew(0x3A7F, 5, 10, 0));
  CHECK(!filter.acceptIfNew(0x3A7F, 5, 10, 1));
  CHECK(filter.acceptIfNew(0x3A7F, 5, 11, 2));
  CHECK(!filter.acceptIfNew(0x3A7F, 5, 9, 3));

  bool everyStepAccepted = true;
  for (uint32_t sequence = 12; sequence <= 0xFFFF; ++sequence) {
    everyStepAccepted &= filter.acceptIfNew(0x3A7F, 5, static_cast<uint16_t>(sequence), 4);
  }
  CHECK(everyStepAccepted);
  // One step past 0xFFFF is later in arithmetic modulo 2^16; a jump back is a repetition.
  CHECK(filter.acceptIfNew(0x3A7F, 5, 0x0000, 5));
  CHECK(!filter.acceptIfNew(0x3A7F, 5, 0xFFF0, 5));
  // A new epoch is always accepted.
  CHECK(filter.acceptIfNew(0x3A7F, 6, 0, 6));
  CHECK(!filter.acceptIfNew(0x3A7F, 6, 0, 7));

  // A full table replaces the source heard least recently.
  for (uint16_t source = 1; source <= MAXIMUM_TRACKED_SOURCES; ++source) {
    CHECK(filter.acceptIfNew(source, 1, 1, 100 + source));
  }
  CHECK(filter.acceptIfNew(0x3A7F, 6, 0, 200));
}

static void testHelloPayload() {
  HelloContent content{};
  content.model = 2;
  content.version = 7;
  content.transmitted = 123456;
  content.neighborCount = 2;
  content.neighbors[0] = {0x1234, -45, 9.25f};
  content.neighbors[1] = {0xBEEF, -131, -12.5f};

  uint8_t buffer[255];
  const size_t length = PresenceService::encodePayload(content, buffer);
  CHECK(length == HELLO_FIXED_SIZE + 2 * HELLO_NEIGHBOR_SIZE);

  HelloContent decoded{};
  CHECK(PresenceService::decodePayload(buffer, length, decoded));
  CHECK(decoded.model == 2 && decoded.version == 7 && decoded.transmitted == 123456);
  CHECK(decoded.neighborCount == 2 && decoded.neighbors[1].id == 0xBEEF);
  CHECK(decoded.neighbors[1].rssi == -131 && decoded.neighbors[1].snr == -12.5f);
  CHECK(!PresenceService::decodePayload(buffer, length - 1, decoded));
}

static void testEchoPayload() {
  uint8_t buffer[255];
  const size_t length = EchoService::encodeReply(42, -87.6f, -3.3f, 16, buffer);
  float rssi = 0.0f;
  float snr = 0.0f;
  EchoService::decodeReplyQuality(buffer, rssi, snr);
  CHECK(length == 16 && buffer[0] == 42 && buffer[1] == 0);
  CHECK(rssi == -88.0f && snr == -3.25f);
}

static void testEchoDeadline() {
  // The loop reads the clock at 1000 and the echo command, later in the same pass, at 1001.
  EchoService echo;
  echo.prepare(0x00F4, 1, 16, 1001);
  CHECK(!echo.hasExpired(1000));
  // 18 ms on air: the reply has twice that plus the margin, 1036 ms from the start of the request.
  echo.markTransmitting(0, 1002, 18000);
  CHECK(echo.timeoutMillis() == 1036);
  CHECK(!echo.hasExpired(2037));
  CHECK(echo.hasExpired(2038));
  // Across the wrap of millis().
  echo.prepare(0x00F4, 2, 16, 0xFFFFFF00u);
  echo.markTransmitting(0, 0xFFFFFF00u, 18000);
  CHECK(!echo.hasExpired(0xFFFFFF00u + 1035));
  CHECK(echo.hasExpired(0xFFFFFF00u + 1036));
}

static void testTestRuns() {
  uint8_t buffer[255];
  CHECK(TestRunService::encodePayload(TestFields{3, 299, 300, 0}, 239, buffer) == 239);
  TestFields decoded{};
  CHECK(TestRunService::decodePayload(buffer, 239, decoded));
  CHECK(decoded.run == 3 && decoded.index == 299 && decoded.count == 300);
  TestRunService::encodePayload(TestFields{1, 5, 5, 0}, 8, buffer);
  CHECK(!TestRunService::decodePayload(buffer, 8, decoded));

  TestRunService runs;
  CHECK(runs.startSending(2, 8, 0, 1000) == 1);
  CHECK(runs.isFrameDue(1000));
  runs.buildNextPayload(buffer);
  runs.onFrameStarted(10);
  CHECK(!runs.isFrameDue(1000));
  CHECK(!runs.onFrameSent(20, 1001));
  runs.buildNextPayload(buffer);
  runs.onFrameStarted(30);
  CHECK(runs.onFrameSent(40, 1002));
  CHECK(runs.sender().sent == 2);
  CHECK(runs.sender().lastEndMicros - runs.sender().firstStartMicros == 30);

  bool opened = false;
  bool completed = false;
  ReceiverRun *run = runs.recordTestFrame(0x3A7F, TestFields{9, 0, 2, 0}, -50.0f, 8.0f, 5000, 16,
                                          opened, completed);
  CHECK(run != nullptr && opened && !completed);
  CHECK(run->deadlineMillis == 5000 + 2 * 16 + RESPONSE_MARGIN_MS);
  run = runs.recordTestFrame(0x3A7F, TestFields{9, 1, 2, 0}, -60.0f, 6.0f, 5020, 16, opened,
                             completed);
  CHECK(run != nullptr && !opened && completed && run->received == 2);
  CHECK(run->rssiMinimum == -60.0f && run->rssiMaximum == -50.0f);
}

static void testEventFields() {
  // setNodeId has to create the member, also inside nested objects, and round values print clean.
  JsonDocument document;
  JsonObject event = document.to<JsonObject>();
  event["ev"] = "hello";
  setNodeId(event, "src", 0xD6D8);
  event["rssi"] = roundToDecimals(-35.53f, 1);
  event["snr"] = roundToDecimals(9.1f, 2);
  JsonObject neighbor = event["neighbors"].to<JsonArray>().add<JsonObject>();
  setNodeId(neighbor, "id", 0x00F4);
  char line[128];
  serializeJson(document, line, sizeof(line));
  CHECK(std::strcmp(line, "{\"ev\":\"hello\",\"src\":\"D6D8\",\"rssi\":-35.5,\"snr\":9.1,"
                          "\"neighbors\":[{\"id\":\"00F4\"}]}") == 0);
}

int main() {
  testTimeOnAir();
  testDuplicateFilter();
  testHelloPayload();
  testEchoPayload();
  testEchoDeadline();
  testTestRuns();
  testEventFields();
  if (failureCount == 0) {
    std::printf("All host tests passed.\n");
    return 0;
  }
  std::printf("%d host test checks failed.\n", failureCount);
  return 1;
}
