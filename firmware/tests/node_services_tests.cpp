// Host tests of the protocol policy of NodeServices: the order of the reception checks, the
// assembly of the frames, what the node transmits next and the chains across nodes, with the
// nodes connected through a simulated medium as their radios would connect them.

#include <cstring>
#include <string>
#include <vector>

#include "application/console_commands.h"
#include "application/node_services.h"
#include "generated_test_vectors.h"
#include "host_test_harness.h"
#include "messages/echo_message.h"
#include "network/frame.h"
#include "simulated_network.h"

using namespace firmware;

static constexpr uint16_t OWN_NODE_ID = 0x1A2B;
static constexpr uint16_t OTHER_NODE_ID = 0x3A7F;

// The type of a transmitted frame as the tx event names it, or "none".
static std::string kindOf(const QueuedFrame *frame) {
  return frame == nullptr ? "none" : messageTypeName(frame->description.type);
}

// A frame as another node would build it.
static std::vector<uint8_t> frameFrom(uint16_t source, uint16_t destination, uint8_t type,
                                      uint16_t sequence, const uint8_t *body, size_t bodyLength) {
  const FrameHeader header{type, source, destination, 1, sequence};
  std::vector<uint8_t> frame(MAXIMUM_FRAME_SIZE);
  frame.resize(encodeFrame(header, body, bodyLength, frame.data()));
  return frame;
}

static std::vector<uint8_t> echoRequestFrom(uint16_t source, uint16_t destination,
                                            uint16_t sequence) {
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  const size_t length = encodeEchoRequest(EchoRequestMessage{7, MINIMUM_ECHO_SIZE}, body);
  return frameFrom(source, destination, static_cast<uint8_t>(MessageType::EchoRequest), sequence,
                   body, length);
}

// ---------------------------------------------------------------------------------------------
// Reception

// The checks of docs/protocol/frame.md, "Recepción", in their order: each frame fails exactly one
// and gets its event, and only a frame that passes them all counts and records its source.
J5_HOST_TEST(testReceptionChecks) {
  SimulatedNode node(OWN_NODE_ID);
  SimulatedMedium medium{&node};
  medium.rssi = -90.5f;
  medium.snr = -3.25f;
  NodeServices &services = node.services;
  const uint32_t now = 100;

  ReceivedFrame corrupted{};
  corrupted.length = 20;
  corrupted.rssi = -90.5f;
  corrupted.snr = -3.25f;
  corrupted.integrityVerified = false;
  node.console.output.millis = now;
  services.receive(corrupted, now, node.settings);

  const std::vector<uint8_t> request = echoRequestFrom(OTHER_NODE_ID, 0x00F4, 1);
  medium.deliver(node, request.data(), FRAME_OVERHEAD - 1, now);
  std::vector<uint8_t> forged = request;
  forged[FRAME_HEADER_SIZE] ^= 0x01;
  medium.deliver(node, forged.data(), forged.size(), now);
  const std::vector<uint8_t> unknown =
      frameFrom(OTHER_NODE_ID, BROADCAST_NODE_ID, 0x7F, 2, nullptr, 0);
  medium.deliver(node, unknown.data(), unknown.size(), now);
  const uint8_t shortBody[ECHO_REPLY_FIELDS_SIZE - 1] = {};
  const std::vector<uint8_t> malformed =
      frameFrom(OTHER_NODE_ID, BROADCAST_NODE_ID, static_cast<uint8_t>(MessageType::EchoRequest), 3,
                shortBody, sizeof(shortBody));
  medium.deliver(node, malformed.data(), malformed.size(), now);
  const std::vector<uint8_t> own = echoRequestFrom(OWN_NODE_ID, BROADCAST_NODE_ID, 4);
  medium.deliver(node, own.data(), own.size(), now);
  CHECK(node.console.output.text() ==
        R"({"t":100,"ev":"drop","reason":"crc","size":20,"rssi":-90.5,"snr":-3.25})"
        "\n"
        R"({"t":100,"ev":"drop","reason":"short","size":15,"rssi":-90.5,"snr":-3.25})"
        "\n"
        R"({"t":100,"ev":"drop","reason":"tag","size":20,"rssi":-90.5,"snr":-3.25})"
        "\n"
        R"({"t":100,"ev":"drop","reason":"type","size":16,"rssi":-90.5,"snr":-3.25})"
        "\n"
        R"({"t":100,"ev":"drop","reason":"body","size":19,"rssi":-90.5,"snr":-3.25})"
        "\n"
        R"({"t":100,"ev":"id_conflict","epoch":1,"seq":4,"rssi":-90.5,"snr":-3.25})"
        "\nid conflict");
  CHECK(services.receivedCount() == 0 && !services.neighbors.contains(OTHER_NODE_ID, now));

  // A frame for another node counts and makes its source a neighbor, and nothing else.
  node.console.clear();
  medium.deliver(node, request.data(), request.size(), now);
  CHECK(node.console.output.lines.empty() && services.queue.isEmpty());
  CHECK(services.receivedCount() == 1 && services.neighbors.contains(OTHER_NODE_ID, now));
  medium.deliver(node, request.data(), request.size(), now);
  CHECK(node.console.output.text() ==
        R"({"t":100,"ev":"duplicate","src":"3A7F","epoch":1,"seq":1,"type":"echo_request"})");
  CHECK(services.receivedCount() == 1);

  // A request for this node reaches the echo, whose reply goes before the frames that wait.
  services.presence.requestImmediate();
  CHECK(kindOf(services.nextFrame(now, node.settings)) == "hello");
  const std::vector<uint8_t> mine = echoRequestFrom(OTHER_NODE_ID, OWN_NODE_ID, 5);
  medium.deliver(node, mine.data(), mine.size(), now);
  CHECK(services.receivedCount() == 2);
  const QueuedFrame *reply = services.nextFrame(now, node.settings);
  CHECK(kindOf(reply) == "echo_reply" && reply->description.destination == OTHER_NODE_ID);
}

// ---------------------------------------------------------------------------------------------
// Transmission

// The header of every frame comes from the node, and a full queue refuses a frame before it takes
// a sequence number, so the sequence has no gaps.
J5_HOST_TEST(testFrameAssembly) {
  SimulatedNode node(OWN_NODE_ID);
  SimulatedMedium medium{&node};
  NodeServices &services = node.services;
  for (uint16_t source = 1; source <= TRANSMIT_QUEUE_CAPACITY; ++source) {
    const std::vector<uint8_t> request = echoRequestFrom(source, OWN_NODE_ID, 1);
    medium.deliver(node, request.data(), request.size(), 100);
  }
  CHECK(services.queue.isFull() && node.sequences.nextSequence == TRANSMIT_QUEUE_CAPACITY);
  CHECK(!services.requestEcho(OTHER_NODE_ID, MINIMUM_ECHO_SIZE));
  CHECK(node.sequences.nextSequence == TRANSMIT_QUEUE_CAPACITY && !services.echo.isPending());

  const QueuedFrame *frame = medium.transmit(node, 200);
  FrameHeader header{};
  const uint8_t *payload = nullptr;
  size_t payloadLength = 0;
  CHECK(decodeFrame(frame->data, frame->length, header, payload, payloadLength) ==
        FrameCheck::Valid);
  CHECK(header.source == OWN_NODE_ID && header.destination == TRANSMIT_QUEUE_CAPACITY);
  CHECK(header.epoch == 1 && header.sequence == TRANSMIT_QUEUE_CAPACITY - 1);
  CHECK(header.sequence == frame->description.sequence);
  CHECK(services.requestEcho(OTHER_NODE_ID, MINIMUM_ECHO_SIZE));
  CHECK(node.sequences.nextSequence == TRANSMIT_QUEUE_CAPACITY + 1);
}

// What leaves when the transmitter is free: a TEST frame, then the HELLO, and fragments and
// reports only while the HELLO messages are not suspended. A burst postpones the periodic HELLO
// but not the one for a change of version.
J5_HOST_TEST(testTransmitArbitration) {
  SimulatedNode node(OWN_NODE_ID);
  SimulatedMedium medium{&node};
  NodeServices &services = node.services;
  char detail[ERROR_DETAIL_CAPACITY];
  CHECK(kindOf(medium.transmit(node, 0)) == "none");
  services.transfer.setFragmentSize(MINIMUM_FRAGMENT_SIZE);
  CHECK(services.transfer.loadImage(SIGNED_IMAGE_VECTOR_IMAGE, detail, sizeof(detail)) ==
        ImageLoad::Accepted);
  CHECK(kindOf(medium.transmit(node, 100)) == "hello");
  // Any HELLO sent: the next periodic one follows the usual period.
  CHECK(!services.presence.isPeriodicHelloDue(100 + HELLO_PERIOD_MS - HELLO_JITTER_MS - 1));
  CHECK(kindOf(medium.transmit(node, 110)) == "fragment");

  const uint32_t later = 110 + HELLO_PERIOD_MS + HELLO_JITTER_MS;
  CHECK(services.presence.isPeriodicHelloDue(later) && !services.isHelloDue(later));
  CHECK(kindOf(medium.transmit(node, later)) == "fragment");
  CHECK(services.activation.activateAvailable(ActivationCause::Console, NO_NODE_ID, later));
  CHECK(kindOf(medium.transmit(node, later + 10)) == "hello");

  // A run suspends both, even a HELLO asked for at once.
  node.console.output.millis = later + 20;
  services.runs.startSending(2, MINIMUM_TEST_SIZE, 1000, later + 20);
  services.presence.requestImmediate();
  CHECK(kindOf(medium.transmit(node, later + 20)) == "test");
  CHECK(services.isSuspended() && kindOf(medium.transmit(node, later + 30)) == "none");
  CHECK(kindOf(medium.transmit(node, later + 1020)) == "test");
  CHECK(!services.runs.isActive());
  CHECK(kindOf(medium.transmit(node, later + 1030)) == "hello");
  CHECK(kindOf(medium.transmit(node, later + 1040)) == "fragment");

  // So does a hold.
  node.console.output.millis = later + 1050;
  services.presence.hold(60000, later + 1050);
  services.presence.requestImmediate();
  CHECK(services.isSuspended() && kindOf(medium.transmit(node, later + 1050)) == "none");
  node.console.output.millis = later + 1060;
  services.presence.release(later + 1060);
  CHECK(kindOf(medium.transmit(node, later + 1060)) == "hello");
  CHECK(kindOf(medium.transmit(node, later + 1070)) == "fragment");
  CHECK(!services.transfer.isBurstInProgress(later + 1080));
}

// A sender with interval 0 finds its next frame due in every pass, so nothing asks whether a HELLO
// is due while the run goes on. The end of the run still delays the HELLO, which would otherwise
// leave at once at its old time.
J5_HOST_TEST(testHelloAfterRunWithoutInterval) {
  SimulatedNode node(OWN_NODE_ID);
  SimulatedMedium medium{&node};
  NodeServices &services = node.services;
  node.console.output.millis = 20000;
  services.runs.startSending(3, MINIMUM_TEST_SIZE, 0, 20000);
  for (uint32_t frame = 0; frame < 3; ++frame) {
    CHECK(kindOf(medium.transmit(node, 20000 + 10 * frame)) == "test");
    services.poll(20000 + 10 * frame);
  }
  CHECK(!services.runs.isActive());
  // The periodic HELLO of the boot was due long ago; the end of the run at 20020 moves it.
  CHECK(kindOf(medium.transmit(node, 20030)) == "none");
  CHECK(!services.isHelloDue(20020 + FIRST_HELLO_MINIMUM_DELAY_MS - 1));
  CHECK(kindOf(medium.transmit(node, 20020 + FIRST_HELLO_MAXIMUM_DELAY_MS)) == "hello");
}

// ---------------------------------------------------------------------------------------------
// Across nodes

// An update between two nodes, as on the air: the origin loads and activates an image and
// announces it, its burst loses a fragment, the receiver reports it, the repair completes the
// image and the receiver activates it because its neighbor already runs it.
J5_HOST_TEST(testUpdateBetweenNodes) {
  SimulatedNode origin(OTHER_NODE_ID);
  SimulatedNode receiver(OWN_NODE_ID);
  SimulatedMedium medium{&origin, &receiver};
  bool lost = false;
  medium.loses = [&](const SimulatedNode &sender, const QueuedFrame &frame) {
    const bool loses = !lost && &sender == &origin &&
                       frame.description.type == MessageType::Fragment &&
                       frame.description.index == 2;
    lost = lost || loses;
    return loses;
  };
  char detail[ERROR_DETAIL_CAPACITY];
  origin.services.transfer.setFragmentSize(MINIMUM_FRAGMENT_SIZE);
  CHECK(origin.services.transfer.loadImage(SIGNED_IMAGE_VECTOR_IMAGE, detail, sizeof(detail)) ==
        ImageLoad::Accepted);
  CHECK(origin.services.activation.activateAvailable(ActivationCause::Console, NO_NODE_ID, 0));
  origin.console.clear();
  receiver.console.clear();
  medium.run(0, 500, 10);

  const std::string version = std::to_string(SIGNED_IMAGE_VECTOR_VERSION);
  CHECK(lost && receiver.services.activation.activeVersion() == SIGNED_IMAGE_VECTOR_VERSION);
  // The last fragment of the burst ends at 40 ms plus its time on air.
  CHECK(origin.eventsNamed({"burst_start", "burst_done", "report_received"}) ==
        R"({"t":10,"ev":"burst_start","version":)" + version +
            R"(,"size":32,"count":4,"cause":"load","trigger":null})"
            "\n"
            R"({"t":40,"ev":"burst_done","version":)" +
            version +
            R"(,"size":32,"sent":4,"duration":47984})"
            "\n"
            R"({"t":40,"ev":"report_received","src":"1A2B","version":)" +
            version +
            R"(,"size":32,"count":4,"missing":[2]})"
            "\n"
            R"({"t":50,"ev":"burst_start","version":)" +
            version +
            R"(,"size":32,"count":1,"cause":"report","trigger":"1A2B"})"
            "\n"
            R"({"t":50,"ev":"burst_done","version":)" +
            version + R"(,"size":32,"sent":1,"duration":26944})");
  // Once complete, the receiver relays the image to its own neighbors in a full burst.
  CHECK(receiver.eventsNamed({"report_sent", "image", "activation", "burst_start"}) ==
        R"({"t":40,"ev":"report_sent","dst":"3A7F","version":)" + version +
            R"(,"size":32,"count":4,"missing":[2],"round":1})"
            "\n"
            R"({"t":50,"ev":"image","version":)" +
            version +
            R"(,"size":29,"image_size":102,"via":"radio","src":"3A7F","fragments":4,"reports":1,)"
            R"("duration":40})"
            "\n"
            R"({"t":50,"ev":"activation","version":)" +
            version +
            R"(,"previous":0,"cause":"neighbor","src":"3A7F"})"
            "\n"
            R"({"t":60,"ev":"burst_start","version":)" +
            version + R"(,"size":231,"count":1,"cause":"complete","trigger":null})");
}
