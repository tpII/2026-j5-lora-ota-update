// Host tests of the services, the activation controller and the events of the node: what each one
// decides and the exact console lines it writes.

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "application/console_commands.h"
#include "application/node_events.h"
#include "application/node_services.h"
#include "configuration.h"
#include "console/event_sink.h"
#include "console_line_recorder.h"
#include "encoding/hex_codec.h"
#include "generated_test_vectors.h"
#include "host_test_harness.h"
#include "messages/echo_message.h"
#include "messages/hello_message.h"
#include "messages/test_message.h"
#include "network/neighbor_table.h"
#include "radio/time_on_air.h"
#include "services/activation_controller.h"
#include "services/echo_service.h"
#include "services/presence_service.h"
#include "services/test_run_service.h"
#include "signed_image_builder.h"
#include "simulated_network.h"

using namespace firmware;

static constexpr uint16_t OWN_NODE_ID = 0x1A2B;

static ReceivedFrame receivedFrame(float rssi, float snr, float frequencyError = 0.0f,
                                   int64_t receivedAtMicros = 0, size_t length = 24) {
  ReceivedFrame frame{};
  frame.length = length;
  frame.rssi = rssi;
  frame.snr = snr;
  frame.frequencyError = frequencyError;
  frame.integrityVerified = true;
  frame.receivedAtMicros = receivedAtMicros;
  return frame;
}

static FrameHeader frameHeader(MessageType type, uint16_t source, uint16_t destination,
                               uint8_t epoch, uint16_t sequence) {
  return FrameHeader{static_cast<uint8_t>(type), source, destination, epoch, sequence};
}

// ---------------------------------------------------------------------------------------------
// Event sink

J5_HOST_TEST(testEventSinkLines) {
  RecordingConsole console;
  EventSink &events = console.events;
  console.output.millis = 4242;
  events.error("radio", ErrorReason::RadioFailure, "apply", -2);
  events.error("status", ErrorReason::Usage, "status");
  events.error("frobnicate", ErrorReason::UnknownCommand);
  CHECK(
      console.output.text() ==
      R"({"t":4242,"ev":"error","cmd":"radio","reason":"radio_failure","detail":"apply","code":-2})"
      "\nerror radio radio_failure\n"
      R"({"t":4242,"ev":"error","cmd":"status","reason":"usage","detail":"status"})"
      "\nerror status usage\n"
      R"({"t":4242,"ev":"error","cmd":"frobnicate","reason":"unknown_command"})"
      "\nerror frobnicate unknown_command");
  // Debug text goes to the OLED too; writeText only to the console, and never as an event.
  CHECK(console.output.displayText() ==
        "error radio radio_failure\nerror status usage\nerror frobnicate unknown_command");
  console.clear();
  events.writeText("commands:");
  events.writeText("{not an event}");
  events.debug("%s", "{not an event either}");
  CHECK(console.output.text() == "commands:" && console.output.displayLines.size() == 1);
  // Debug text longer than the OLED buffer is cut.
  console.clear();
  events.debug("%s", std::string(100, 'x').c_str());
  CHECK(console.output.text() == std::string(EventSink::DEBUG_TEXT_CAPACITY - 1, 'x'));

  // An event that does not fit the line buffer is dropped and counted.
  console.clear();
  static uint8_t bytes[EVENT_LINE_CAPACITY / 2] = {};
  JsonObject event = events.beginEvent(ConsoleEvent::Program);
  event["version"] = 1;
  event["size"] = sizeof(bytes);
  events.writeEvent("code", bytes, sizeof(bytes));
  CHECK(console.output.lines.empty() && events.droppedLineCount() == 1);
  event = events.beginEvent(ConsoleEvent::Program);
  event["version"] = 1;
  event["size"] = 3;
  events.writeEvent("code", bytes, 3);
  CHECK(console.output.text() ==
        R"({"t":4242,"ev":"program","version":1,"size":3,"code":"000000"})");
}

// Counts the lines that a transport with a full buffer drops.
class FullTransportOutput : public EventOutput {
public:
  uint32_t eventMillis() const override { return 0; }
  uint8_t writeLine(const char *, size_t) override { return 2; }
  void showDebugText(const char *) override {}
};

J5_HOST_TEST(testEventSinkDroppedLines) {
  FullTransportOutput output;
  EventSink events;
  events.begin(output);
  events.debug("one");
  events.beginEvent(ConsoleEvent::Radio);
  events.writeEvent();
  CHECK(events.droppedLineCount() == 4);
}

// ---------------------------------------------------------------------------------------------
// Events of the node

J5_HOST_TEST(testNodeEvents) {
  RecordingConsole console;
  EventSink &events = console.events;
  console.output.millis = 12;

  writeBootEvent(events, 0x3A7F, BoardModel::HeltecV2, 3);
  CHECK(console.output.text() == std::string(R"({"t":12,"ev":"boot","id":"3A7F","model":"V2",)") +
                                     R"("epoch":3,"firmware":")" + FIRMWARE_VERSION +
                                     R"(","protocol":2,"key":"default","operator_key":"default"})");
  console.clear();

  writeStatusEvent(events, 0x3A7F, BoardModel::HeltecV43, 3, NodeCounters{10, 20, 1, 200000});
  writeRadioEvent(events, defaultRadioSettings(), 4, BoardModel::HeltecV2);
  RadioSettings settings = defaultRadioSettings();
  settings.frequencyMhz = 923.3f;
  settings.spreadingFactor = 9;
  settings.bandwidthKhz = 125;
  settings.transmitPowerDbm = 26;
  settings.lowNoiseAmplifierEnabled = true;
  writeRadioEvent(events, settings, 19, BoardModel::HeltecV43);
  writeWifiEvent(events, true, "J5-3A7F", 1, 2);
  writeWifiEvent(events, false, "J5-3A7F", 1, 0);
  CHECK(console.output.text() ==
        R"({"t":12,"ev":"status","id":"3A7F","model":"V4.3","epoch":3,"tx":10,"rx":20,)"
        R"("dropped":1,"heap":200000})"
        "\n"
        R"({"t":12,"ev":"radio","freq":915.9,"sf":7,"bw":500,"cr":5,"preamble":8,"sync":18,)"
        R"("power":4,"chip":4,"lna":null})"
        "\n"
        R"({"t":12,"ev":"radio","freq":923.3,"sf":9,"bw":125,"cr":5,"preamble":8,"sync":18,)"
        R"("power":26,"chip":19,"lna":"on"})"
        "\n"
        R"({"t":12,"ev":"wifi","state":"on","ssid":"J5-3A7F","channel":1,"clients":2})"
        "\n"
        R"({"t":12,"ev":"wifi","state":"off","ssid":"J5-3A7F","channel":1,"clients":0})");
  console.clear();

  FrameDescription description{};
  description.destination = BROADCAST_NODE_ID;
  description.sequence = 5;
  description.run = 1;
  description.index = 2;
  description.version = 7;
  const TransmitTiming timing{1000, 5000, 6040, 1030};
  const MessageType types[] = {MessageType::Hello, MessageType::EchoRequest, MessageType::EchoReply,
                               MessageType::Test,  MessageType::Fragment,    MessageType::Report};
  for (MessageType type : types) {
    description.type = type;
    writeTransmissionEvent(events, description, 40, timing);
  }
  const std::string common = R"("dst":"FFFF","seq":5,"size":40,"toa":1040,"toa_calc":1030)";
  CHECK(console.output.text() == R"({"t":12,"ev":"tx","type":"hello",)" + common +
                                     "}\n"
                                     R"({"t":12,"ev":"tx","type":"echo_request",)" +
                                     common +
                                     "}\n"
                                     R"({"t":12,"ev":"tx","type":"echo_reply",)" +
                                     common +
                                     "}\n"
                                     R"({"t":12,"ev":"tx","type":"test",)" +
                                     common +
                                     R"(,"run":1,"index":2})"
                                     "\n"
                                     R"({"t":12,"ev":"tx","type":"fragment",)" +
                                     common +
                                     R"(,"version":7,"index":2})"
                                     "\n"
                                     R"({"t":12,"ev":"tx","type":"report",)" +
                                     common + R"(,"version":7})");
  console.clear();

  const ReceivedFrame frame = receivedFrame(-100.5f, -7.25f, 0.0f, 0, 30);
  writeDropEvent(events, DropReason::Crc, frame);
  writeDropEvent(events, DropReason::Body, frame);
  const FrameHeader header = frameHeader(MessageType::Hello, 0x3A7F, BROADCAST_NODE_ID, 2, 9);
  writeDuplicateEvent(events, header, MessageType::Hello);
  writeIdConflictEvent(events, header, receivedFrame(-40.0f, 10.0f));
  CHECK(console.output.text() ==
        R"({"t":12,"ev":"drop","reason":"crc","size":30,"rssi":-100.5,"snr":-7.25})"
        "\n"
        R"({"t":12,"ev":"drop","reason":"body","size":30,"rssi":-100.5,"snr":-7.25})"
        "\n"
        R"({"t":12,"ev":"duplicate","src":"3A7F","epoch":2,"seq":9,"type":"hello"})"
        "\n"
        R"({"t":12,"ev":"id_conflict","epoch":2,"seq":9,"rssi":-40,"snr":10})"
        "\nid conflict");
}

// ---------------------------------------------------------------------------------------------
// Presence

// Records the HELLO messages of the neighbors that presence passes on.
class RecordingHelloListener : public HelloListener {
public:
  std::vector<std::string> hellos;

  void onNeighborHello(uint16_t source, const AnnouncedState &announced,
                       uint32_t nowMillis) override {
    char text[48];
    std::snprintf(text, sizeof(text), "%04X v%u at %u", source,
                  static_cast<unsigned>(announced.version), static_cast<unsigned>(nowMillis));
    hellos.push_back(text);
  }
};

// A presence service with its console, its neighbor table and its listener.
struct PresenceNode {
  RecordingConsole console;
  NeighborTable neighbors;
  RecordingHelloListener listener;
  PresenceService presence;

  PresenceNode() { presence.begin(console.events, neighbors, listener, 0); }
};

static HelloMessage neighborHello() {
  HelloMessage message{};
  message.announced.modelKnown = true;
  message.announced.model = BoardModel::HeltecV43;
  message.announced.lastFault = VmFault::DivisionByZero;
  message.announced.vmFailing = true;
  message.announced.version = 3;
  message.announced.available = 4;
  message.announced.transmitted = 120;
  message.neighborCount = 2;
  message.neighbors[0] = HelloNeighborEntry{OWN_NODE_ID, -70, 6.25f};
  message.neighbors[1] = HelloNeighborEntry{0x00F4, -101, -3.5f};
  return message;
}

J5_HOST_TEST(testPresenceHelloEvents) {
  PresenceNode node;
  RecordingConsole &console = node.console;
  NeighborTable &neighbors = node.neighbors;
  PresenceService &presence = node.presence;

  console.output.millis = 1000;
  const FrameHeader header = frameHeader(MessageType::Hello, 0x3A7F, BROADCAST_NODE_ID, 2, 17);
  presence.handleHello(header, neighborHello(), receivedFrame(-71.5f, 6.25f, 1234.6f), 1000);
  CHECK(console.output.text() ==
        R"({"t":1000,"ev":"hello","src":"3A7F","epoch":2,"seq":17,"model":"V4.3","version":3,)"
        R"("available":4,"vm_fault":"division_by_zero","vm_failing":true,"tx":120,"rssi":-71.5,)"
        R"("snr":6.25,"ferr":1235,"neighbors":[{"id":"1A2B","rssi":-70,"snr":6.25},)"
        R"({"id":"00F4","rssi":-101,"snr":-3.5}]})"
        "\nhello 3A7F -72 dBm");
  // The listener hears the HELLO after its event.
  CHECK(node.listener.hellos.size() == 1 && node.listener.hellos[0] == "3A7F v3 at 1000");
  CHECK(neighbors.neighbors(1000).size() == 1);
  CHECK(neighbors.neighbors(1000).begin()->announced.version == 3);

  // The neighbor events of status share the fields of the HELLO; a neighbor heard only through
  // other frames has announced nothing yet.
  neighbors.recordFrame(0x00F4, -90.0f, 1.0f, 2000);
  console.clear();
  console.output.millis = 3500;
  presence.reportNeighbors(3500);
  CHECK(console.output.text() ==
        R"({"t":3500,"ev":"neighbor","id":"3A7F","model":"V4.3","version":3,"available":4,)"
        R"("vm_fault":"division_by_zero","vm_failing":true,"tx":120,"rssi":-71.5,"snr":6.25,)"
        R"("age":2500})"
        "\n"
        R"({"t":3500,"ev":"neighbor","id":"00F4","model":null,"version":0,"available":0,)"
        R"("vm_fault":null,"vm_failing":false,"tx":0,"rssi":-90,"snr":1,"age":1500})");

  // The HELLO of the node lists its neighbors with the resolution of the body.
  AnnouncedState own{};
  own.modelKnown = true;
  own.model = BoardModel::HeltecV2;
  own.version = 1;
  own.available = 2;
  own.transmitted = 9;
  FrameDescription description{};
  uint8_t payload[MAXIMUM_PAYLOAD_SIZE];
  const size_t length = presence.buildHello(own, 4000, description, payload);
  CHECK(description.type == MessageType::Hello && description.destination == BROADCAST_NODE_ID);
  HelloMessage sent{};
  CHECK(decodeHello(payload, length, sent) && sent.neighborCount == 2);
  CHECK(sent.announced.version == 1 && sent.announced.available == 2);
  CHECK(sent.neighbors[0].id == 0x3A7F && sent.neighbors[0].rssi == -72);
  CHECK(sent.neighbors[1].id == 0x00F4 && sent.neighbors[1].rssi == -90);
}

// The hold of the HELLO messages, on a node connected as on the board.
J5_HOST_TEST(testPresenceHold) {
  SimulatedNode node(OWN_NODE_ID);
  SimulatedMedium medium{&node};
  RecordingConsole &console = node.console;
  NodeServices &services = node.services;
  PresenceService &presence = services.presence;

  console.output.millis = 5000;
  presence.hold(60000, 5000);
  CHECK(console.output.text() == R"({"t":5000,"ev":"presence","state":"off","remaining":60})"
                                 "\nhello off");
  CHECK(services.isSuspended() && !services.isHelloDue(10000));

  // Status reports whole seconds, rounded up.
  console.clear();
  console.output.millis = 35001;
  presence.reportPresence(35001);
  CHECK(console.output.text() == R"({"t":35001,"ev":"presence","state":"off","remaining":30})");

  console.clear();
  presence.poll(64999);
  CHECK(console.output.lines.empty() && services.isSuspended());
  console.output.millis = 65000;
  presence.poll(65000);
  CHECK(console.output.text() == R"({"t":65000,"ev":"presence","state":"on","remaining":null})"
                                 "\nhello on (hold expired)");
  CHECK(!services.isSuspended());
  // The first HELLO comes after the same delay as at boot.
  CHECK(!services.isHelloDue(65000 + FIRST_HELLO_MINIMUM_DELAY_MS - 1));
  CHECK(services.isHelloDue(65000 + FIRST_HELLO_MAXIMUM_DELAY_MS));

  // presence on answers even without a hold.
  console.clear();
  console.output.millis = 70000;
  presence.release(70000);
  CHECK(console.output.text() == R"({"t":70000,"ev":"presence","state":"on","remaining":null})"
                                 "\nhello on");
  presence.hold(1000, 80000);
  presence.release(80500);
  CHECK(!services.isSuspended() && !services.isHelloDue(80500));

  // A run that ends during a hold does not bring the HELLO back.
  console.output.millis = 90000;
  presence.hold(60000, 90000);
  services.runs.startSending(1, MINIMUM_TEST_SIZE, 0, 90000);
  CHECK(medium.transmit(node, 90000)->description.type == MessageType::Test);
  CHECK(!services.runs.isActive() && services.isSuspended());
  CHECK(!services.isHelloDue(90000 + FIRST_HELLO_MAXIMUM_DELAY_MS));
  CHECK(medium.transmit(node, 90000 + FIRST_HELLO_MAXIMUM_DELAY_MS) == nullptr);
}

// ---------------------------------------------------------------------------------------------
// Echo

J5_HOST_TEST(testEchoRequester) {
  RecordingConsole console;
  EchoService echo;
  echo.begin(console.events);
  FrameDescription request{};
  uint8_t payload[MAXIMUM_PAYLOAD_SIZE];

  CHECK(echo.buildRequest(0x00F4, 16, request, payload) == 16);
  CHECK(request.type == MessageType::EchoRequest && request.destination == 0x00F4);
  EchoRequestMessage sent{};
  CHECK(decodeEchoRequest(payload, 16, sent) && sent.number == 1 && sent.size == 16);
  // A request that waits in the queue does not expire, however long it waits.
  CHECK(echo.isPending());
  echo.poll(1000000);
  CHECK(console.output.lines.empty() && echo.isPending());

  // 18 ms on air: the reply has echoLossDeadlineMillis() from the start of the request.
  const uint32_t deadline = echoLossDeadlineMillis(18000);
  echo.onTransmitStarted(request, TransmitTiming{1002, 5000000, 0, 18000});
  const FrameHeader header = frameHeader(MessageType::EchoReply, 0x00F4, OWN_NODE_ID, 1, 9);
  const ReceivedFrame frame = receivedFrame(-79.5f, 8.5f, 0.0f, 5040500);
  echo.handleReply(header, EchoReplyMessage{2, -80.5f, 7.75f, 16}, frame);
  echo.handleReply(frameHeader(MessageType::EchoReply, 0x3A7F, OWN_NODE_ID, 1, 9),
                   EchoReplyMessage{1, -80.5f, 7.75f, 16}, frame);
  echo.poll(1002 + deadline - 1);
  CHECK(console.output.lines.empty());
  console.output.millis = 1042;
  echo.handleReply(header, EchoReplyMessage{1, -80.5f, 7.75f, 16}, frame);
  CHECK(console.output.text() ==
        R"({"t":1042,"ev":"echo","dst":"00F4","n":1,"size":16,"rtt":40500,"rssi":-79.5,)"
        R"("snr":8.5,"remote_rssi":-80.5,"remote_snr":7.75})"
        "\necho 00F4 40.5 ms");
  CHECK(!echo.isPending());

  // A lost reply, with a deadline past the wrap of millis().
  console.clear();
  echo.buildRequest(0x00F4, 16, request, payload);
  const uint32_t beforeWrap = 0xFFFFFF00u;
  const uint32_t lostMillis = beforeWrap + deadline;
  CHECK(lostMillis < beforeWrap);
  echo.onTransmitStarted(request, TransmitTiming{beforeWrap, 0, 0, 18000});
  echo.poll(0xFFFFFFFFu);
  echo.poll(lostMillis - 1);
  CHECK(console.output.lines.empty());
  console.output.millis = lostMillis;
  echo.poll(lostMillis);
  CHECK(console.output.text() == R"({"t":)" + std::to_string(lostMillis) +
                                     R"(,"ev":"echo_lost","dst":"00F4","n":2,"size":16,)"
                                     R"("timeout":)" +
                                     std::to_string(deadline) + "}\necho 00F4 lost");
  CHECK(!echo.isPending());

  // A request that does not go out leaves no echo pending.
  echo.buildRequest(0x00F4, 16, request, payload);
  echo.onTransmitFailed(request);
  CHECK(!echo.isPending());
}

J5_HOST_TEST(testEchoResponder) {
  RecordingConsole console;
  EchoService echo;
  echo.begin(console.events);
  FrameDescription reply{};
  uint8_t payload[MAXIMUM_PAYLOAD_SIZE];
  const FrameHeader header = frameHeader(MessageType::EchoRequest, 0x3A7F, OWN_NODE_ID, 1, 4);
  // The reply has the length of the request and tells how the request arrived.
  CHECK(echo.buildReply(header, EchoRequestMessage{7, 32}, receivedFrame(-60.5f, 9.25f), reply,
                        payload) == 32);
  CHECK(reply.type == MessageType::EchoReply && reply.destination == 0x3A7F);
  EchoReplyMessage sent{};
  CHECK(decodeEchoReply(payload, 32, sent) && sent.number == 7 && sent.snr == 9.25f);
  CHECK(console.output.lines.empty());

  // echo_served once the reply is on the air, never for a reply that did not go out.
  echo.onTransmitFailed(reply);
  echo.onTransmitStarted(reply, TransmitTiming{2400, 0, 0, 30000});
  CHECK(console.output.lines.empty() && !echo.isPending());

  // Each reply keeps its own request, even when they go out in another order, as priority frames
  // do in the queue.
  FrameDescription first{};
  FrameDescription second{};
  echo.buildReply(header, EchoRequestMessage{7, 32}, receivedFrame(-60.5f, 9.25f), first, payload);
  echo.buildReply(frameHeader(MessageType::EchoRequest, 0x00F4, OWN_NODE_ID, 1, 5),
                  EchoRequestMessage{8, 16}, receivedFrame(-90.0f, -2.0f), second, payload);
  console.output.millis = 2500;
  echo.onTransmitStarted(second, TransmitTiming{2500, 0, 0, 30000});
  echo.onTransmitStarted(first, TransmitTiming{2500, 0, 0, 30000});
  CHECK(console.output.text() ==
        R"({"t":2500,"ev":"echo_served","src":"00F4","n":8,"size":16,"rssi":-90,"snr":-2})"
        "\n"
        R"({"t":2500,"ev":"echo_served","src":"3A7F","n":7,"size":32,"rssi":-60.5,"snr":9.25})");
  CHECK(!echo.isPending());
  // A reply that the queue reports twice is served once.
  console.clear();
  echo.onTransmitStarted(first, TransmitTiming{2600, 0, 0, 30000});
  CHECK(console.output.lines.empty());
}

// ---------------------------------------------------------------------------------------------
// Test runs

// Records when the node is left without runs.
class RecordingTestRunListener : public TestRunListener {
public:
  std::vector<uint32_t> ends;

  void onRunsEnded(uint32_t nowMillis) override { ends.push_back(nowMillis); }
};

J5_HOST_TEST(testTestRunSender) {
  RecordingConsole console;
  RecordingTestRunListener listener;
  TestRunService runs;
  runs.begin(console.events, listener);
  FrameDescription description{};
  uint8_t payload[MAXIMUM_PAYLOAD_SIZE];

  console.output.millis = 1000;
  runs.startSending(2, 8, 0, 1000);
  CHECK(console.output.text() == R"({"t":1000,"ev":"run_start","run":1,"count":2,"size":8,)"
                                 R"("interval":0})"
                                 "\nrun 1 start 2x8");
  CHECK(runs.isActive() && runs.isSending() && runs.isFrameDue(1000));
  CHECK(runs.buildNextFrame(description, payload) == 8);
  CHECK(description.type == MessageType::Test && description.destination == BROADCAST_NODE_ID);
  CHECK(description.run == 1 && description.index == 0);
  TestMessage sent{};
  CHECK(decodeTest(payload, 8, sent) && sent.run == 1 && sent.index == 0 && sent.count == 2);
  runs.onTransmitStarted(description, TransmitTiming{1000, 10, 0, 0});
  CHECK(!runs.isFrameDue(1000));
  runs.onTransmitDone(description, TransmitTiming{1001, 10, 20, 0});
  CHECK(runs.isFrameDue(1001));
  runs.buildNextFrame(description, payload);
  CHECK(description.index == 1);
  runs.onTransmitStarted(description, TransmitTiming{1002, 30, 0, 0});
  console.clear();
  console.output.millis = 1003;
  // The run ends with its last frame, from the start of the first frame to the end of the last.
  runs.onTransmitDone(description, TransmitTiming{1003, 30, 40, 0});
  CHECK(console.output.text() == R"({"t":1003,"ev":"run_done","run":1,"count":2,"sent":2,)"
                                 R"("duration":30,"aborted":false})"
                                 "\nrun 1 done 2/2");
  CHECK(!runs.isActive() && listener.ends == std::vector<uint32_t>{1003});

  // A stop waits for the frame on the air.
  runs.startSending(5, 8, 100, 2000);
  runs.buildNextFrame(description, payload);
  runs.onTransmitStarted(description, TransmitTiming{2000, 50, 0, 0});
  runs.requestStop();
  console.clear();
  runs.poll(2000);
  CHECK(console.output.lines.empty() && runs.isSending());
  console.output.millis = 2001;
  runs.onTransmitDone(description, TransmitTiming{2001, 50, 60, 0});
  CHECK(console.output.text() == R"({"t":2001,"ev":"run_done","run":2,"count":5,"sent":1,)"
                                 R"("duration":10,"aborted":true})"
                                 "\nrun 2 done 1/5");

  // A frame that does not go out ends the run at the next pass; the console reports it as
  // aborted, as a stop.
  runs.startSending(5, 8, 0, 3000);
  runs.buildNextFrame(description, payload);
  console.clear();
  runs.onTransmitFailed(description);
  CHECK(console.output.lines.empty() && !runs.isFrameDue(3000));
  console.output.millis = 3000;
  runs.poll(3000);
  CHECK(console.output.text() == R"({"t":3000,"ev":"run_done","run":3,"count":5,"sent":0,)"
                                 R"("duration":0,"aborted":true})"
                                 "\nrun 3 done 0/5");
  // A stop with no frame on the air ends the run at the next pass.
  runs.startSending(5, 8, 0, 4000);
  runs.requestStop();
  CHECK(!runs.isFrameDue(4000));
  runs.poll(4000);
  CHECK(!runs.isActive());
  CHECK(listener.ends == (std::vector<uint32_t>{1003, 2001, 3000, 4000}));
}

J5_HOST_TEST(testTestRunReceiver) {
  RecordingConsole console;
  RecordingTestRunListener listener;
  TestRunService runs;
  runs.begin(console.events, listener);
  const RadioSettings settings = defaultRadioSettings();
  const FrameHeader header = frameHeader(MessageType::Test, 0x3A7F, BROADCAST_NODE_ID, 1, 30);

  console.output.millis = 5000;
  runs.handleTestFrame(header, TestMessage{9, 0, 2, 100, 8}, receivedFrame(-50.0f, 8.0f, -12.4f),
                       settings, 5000);
  CHECK(console.output.text() == R"({"t":5000,"ev":"test_rx","src":"3A7F","run":9,"index":0,)"
                                 R"("count":2,"size":8,"rssi":-50,"snr":8,"ferr":-12})"
                                 "\nrun 9 from 3A7F");
  CHECK(runs.isActive() && !runs.isSending());
  console.clear();
  console.output.millis = 5100;
  runs.handleTestFrame(header, TestMessage{9, 1, 2, 100, 8}, receivedFrame(-60.0f, 6.0f, 3.0f),
                       settings, 5100);
  CHECK(console.output.text() ==
        R"({"t":5100,"ev":"test_rx","src":"3A7F","run":9,"index":1,"count":2,"size":8,)"
        R"("rssi":-60,"snr":6,"ferr":3})"
        "\n"
        R"({"t":5100,"ev":"run_end","src":"3A7F","run":9,"count":2,"received":2,"pdr":1,)"
        R"("rssi_avg":-55,"rssi_min":-60,"rssi_max":-50,"snr_avg":7,"first":5000,"last":5100,)"
        R"("reason":"complete"})"
        "\nrun 9 end 2/2");
  CHECK(!runs.isActive() && listener.ends == std::vector<uint32_t>{5100});

  // Without another frame for runReceptionDeadlineMillis(), from the interval and the time on air
  // of the frame, the run is over.
  const ReceivedFrame lonely = receivedFrame(-51.25f, 7.5f);
  runs.handleTestFrame(header, TestMessage{10, 0, 3, 100, 8}, lonely, settings, 6000);
  const uint32_t endMillis =
      6000 + runReceptionDeadlineMillis(100, computeTimeOnAirMicros(lonely.length, settings));
  console.clear();
  runs.poll(endMillis - 1);
  CHECK(console.output.lines.empty() && runs.isActive());
  console.output.millis = endMillis;
  runs.poll(endMillis);
  CHECK(console.output.text() ==
        R"({"t":)" + std::to_string(endMillis) +
            R"(,"ev":"run_end","src":"3A7F","run":10,"count":3,"received":1,"pdr":0.3333,)"
            R"("rssi_avg":-51.3,"rssi_min":-51.3,"rssi_max":-51.3,"snr_avg":7.5,"first":6000,)"
            R"("last":6000,"reason":"timeout"})"
            "\nrun 10 end 1/3");
  CHECK(listener.ends.size() == 2);

  // A new run from the same source ends the previous one first.
  console.output.millis = 9000;
  runs.handleTestFrame(header, TestMessage{11, 0, 5, 0, 8}, receivedFrame(-50.0f, 8.0f), settings,
                       9000);
  console.clear();
  console.output.millis = 9100;
  runs.handleTestFrame(header, TestMessage{12, 0, 5, 0, 8}, receivedFrame(-50.0f, 8.0f), settings,
                       9100);
  CHECK(console.output.lines.size() == 4);
  CHECK(console.output.lines[0].find(R"("ev":"run_end","src":"3A7F","run":11,)") !=
        std::string::npos);
  CHECK(console.output.lines[0].find(R"("reason":"timeout")") != std::string::npos);
  CHECK(console.output.lines[2].find(R"("ev":"test_rx","src":"3A7F","run":12,)") !=
        std::string::npos);
  CHECK(console.output.lines[3] == "run 12 from 3A7F");
  // The node never stopped receiving, so the listener heard no end.
  CHECK(listener.ends.size() == 2 && runs.isActive());

  // Without a free slot the frame is reported but no run opens.
  for (uint16_t source = 1; source < MAXIMUM_RECEIVER_RUNS; ++source) {
    runs.handleTestFrame(frameHeader(MessageType::Test, source, BROADCAST_NODE_ID, 1, 1),
                         TestMessage{1, 0, 5, 0, 8}, receivedFrame(-50.0f, 8.0f), settings, 9200);
  }
  console.clear();
  runs.handleTestFrame(
      frameHeader(MessageType::Test, MAXIMUM_RECEIVER_RUNS, BROADCAST_NODE_ID, 1, 1),
      TestMessage{1, 0, 5, 0, 8}, receivedFrame(-50.0f, 8.0f), settings, 9300);
  CHECK(console.output.lines.size() == 1);
}

// ---------------------------------------------------------------------------------------------
// Activation

// Makes an image of the program, signed with the development key, the available version of the
// node, as load_image does.
static void makeAvailable(NodeServices &services, uint32_t version, const char *program) {
  char detail[ERROR_DETAIL_CAPACITY];
  CHECK(services.transfer.loadImage(buildSignedImage(version, program).c_str(), detail,
                                    sizeof(detail)) == ImageLoad::Accepted);
}

J5_HOST_TEST(testActivationRule) {
  SimulatedNode node(OWN_NODE_ID);
  RecordingConsole &console = node.console;
  NodeServices &services = node.services;
  ActivationController &activation = services.activation;
  // PRINT R1; HALT.
  const char *const print = "010100";

  // Only an available version newer than the active one activates: none is available yet.
  CHECK(!activation.activateAvailable(ActivationCause::Hello, 0x3A7F, 500));
  CHECK(console.output.lines.empty() && activation.activeVersion() == 0);
  makeAvailable(services, 5, print);
  // The HELLO that announces the available version leaves before the activation.
  FrameDescription description{};
  uint8_t payload[MAXIMUM_PAYLOAD_SIZE];
  services.presence.buildHello(services.announcedState(), 1000, description, payload);
  console.clear();
  CHECK(!services.presence.isImmediateRequested());
  console.output.millis = 1000;
  CHECK(activation.activateAvailable(ActivationCause::Hello, 0x3A7F, 1000));
  CHECK(console.output.text() ==
        R"({"t":1000,"ev":"activation","version":5,"previous":0,"cause":"hello","src":"3A7F"})"
        "\n"
        R"({"t":1000,"ev":"vm","version":5,"size":3,"tick":0,"registers":[0,0,0,0]})"
        "\nVM: program v5");
  // The HELLO announces the new active version at once.
  CHECK(activation.activeVersion() == 5 && services.presence.isImmediateRequested());
  console.clear();
  CHECK(!activation.activateAvailable(ActivationCause::Neighbor, 0x3A7F, 1000));
  CHECK(console.output.lines.empty() && activation.activeVersion() == 5);

  // The first tick runs at once, the next ones every VM_TICK_PERIOD_MS.
  activation.poll(1000);
  CHECK(console.output.text() == R"({"t":1000,"ev":"vm_print","tick":1,"reg":1,"value":0})"
                                 "\nVM: R1 - 0x00000000");
  console.clear();
  activation.poll(1000);
  activation.poll(1000 + VM_TICK_PERIOD_MS - 1);
  CHECK(console.output.lines.empty());
  const int32_t registers[REGISTER_COUNT] = {-1, -2, 3, 2147483647};
  console.output.millis = 2000;
  activation.loadRegisters(registers);
  CHECK(console.output.text() ==
        R"({"t":2000,"ev":"vm","version":5,"size":3,"tick":1,"registers":[-1,-2,3,2147483647]})"
        "\nVM: registers loaded");
  console.clear();
  console.output.millis = 11000;
  activation.poll(1000 + VM_TICK_PERIOD_MS);
  CHECK(console.output.text() == R"({"t":11000,"ev":"vm_print","tick":2,"reg":1,"value":-1})"
                                 "\nVM: R1 - 0xFFFFFFFF");

  // A console activation has no source. DIVI R1, 0; HALT: every tick faults.
  makeAvailable(services, 6, "16010000000000");
  console.clear();
  console.output.millis = 20000;
  CHECK(activation.activateAvailable(ActivationCause::Console, NO_NODE_ID, 20000));
  activation.poll(20000);
  CHECK(console.output.text() ==
        R"({"t":20000,"ev":"activation","version":6,"previous":5,"cause":"console","src":null})"
        "\n"
        R"({"t":20000,"ev":"vm","version":6,"size":7,"tick":0,"registers":[-1,-2,3,2147483647]})"
        "\nVM: program v6\n"
        R"({"t":20000,"ev":"vm_fault","tick":1,"pc":0,"reason":"division_by_zero"})"
        "\nVM: division_by_zero");
  CHECK(activation.lastFault() == VmFault::DivisionByZero && activation.lastTickFaulted());

  // A neighbor activation names the neighbor; the load clears the faults.
  makeAvailable(services, 7, print);
  console.clear();
  console.output.millis = 30000;
  CHECK(activation.activateAvailable(ActivationCause::Neighbor, 0x00F4, 30000));
  CHECK(
      console.output.lines[0] ==
      R"({"t":30000,"ev":"activation","version":7,"previous":6,"cause":"neighbor","src":"00F4"})");
  CHECK(activation.lastFault() == VmFault::None && !activation.lastTickFaulted());
  console.clear();
  activation.reportProgram();
  CHECK(console.output.text() == R"({"t":30000,"ev":"program","version":7,"size":3,)"
                                 R"("code":"010100"})");
}

// The chain that runs across the services, connected as on the node: an image loaded by the
// console is announced at once; a neighbor that runs it activates it through its HELLO, after the
// hello event, and the new active version is announced at once too.
J5_HOST_TEST(testActivationThroughNeighborHello) {
  SimulatedNode node(OWN_NODE_ID);
  RecordingConsole &console = node.console;
  NodeServices &services = node.services;
  FrameDescription description{};
  uint8_t payload[MAXIMUM_PAYLOAD_SIZE];
  const AnnouncedState own{};

  char detail[ERROR_DETAIL_CAPACITY];
  CHECK(services.transfer.loadImage(SIGNED_IMAGE_VECTOR_IMAGE, detail, sizeof(detail)) ==
        ImageLoad::Accepted);
  CHECK(services.isHelloDue(100));
  services.presence.buildHello(own, 100, description, payload);
  CHECK(!services.isHelloDue(100));

  HelloMessage hello{};
  hello.announced.modelKnown = true;
  hello.announced.model = BoardModel::HeltecV2;
  hello.announced.version = SIGNED_IMAGE_VECTOR_VERSION;
  hello.announced.available = SIGNED_IMAGE_VECTOR_VERSION;
  console.clear();
  console.output.millis = 200;
  services.presence.handleHello(frameHeader(MessageType::Hello, 0x3A7F, BROADCAST_NODE_ID, 1, 1),
                                hello, receivedFrame(-60.0f, 8.0f), 200);
  CHECK(console.output.lines.size() == 5);
  CHECK(console.output.lines[0].find(R"("ev":"hello","src":"3A7F")") != std::string::npos);
  const std::string version = std::to_string(SIGNED_IMAGE_VECTOR_VERSION);
  CHECK(console.output.lines[2] == R"({"t":200,"ev":"activation","version":)" + version +
                                       R"(,"previous":0,"cause":"hello","src":"3A7F"})");
  CHECK(services.activation.activeVersion() == SIGNED_IMAGE_VECTOR_VERSION);
  CHECK(services.isHelloDue(200));

  // The same HELLO again changes nothing: the version is already active.
  services.presence.buildHello(own, 200, description, payload);
  console.clear();
  console.output.millis = 300;
  services.presence.handleHello(frameHeader(MessageType::Hello, 0x3A7F, BROADCAST_NODE_ID, 1, 2),
                                hello, receivedFrame(-60.0f, 8.0f), 300);
  CHECK(console.output.lines.size() == 2 && !services.isHelloDue(300));
}
