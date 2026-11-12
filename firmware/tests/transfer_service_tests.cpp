// Host tests of the transfer service: load_image, bursts, reception, the activations it asks for
// and the exact console lines it writes. The transfer between two nodes, with its reports, is in
// node_services_tests.cpp.

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "application/console_commands.h"
#include "configuration.h"
#include "console_line_recorder.h"
#include "encoding/hex_codec.h"
#include "generated_test_vectors.h"
#include "host_test_harness.h"
#include "messages/fragment_message.h"
#include "messages/report_message.h"
#include "network/neighbor_table.h"
#include "services/transfer_service.h"
#include "simulated_network.h"

using namespace firmware;

static constexpr uint16_t SENDER_ID = 0x3A7F;
static constexpr uint16_t RECEIVER_ID = 0x1A2B;

// Records what the transfer asks of the rest of the node.
class RecordingTransferListener : public TransferListener {
public:
  uint32_t active = 0;
  int versionChanges = 0;
  std::vector<std::string> activations;

  uint32_t activeVersion() const override { return active; }
  void onAvailableVersionChanged() override { ++versionChanges; }
  void onActivationWanted(ActivationCause cause, uint16_t source, uint32_t nowMillis) override {
    char text[48];
    std::snprintf(text, sizeof(text), "%s %04X %u", activationCauseName(cause), source,
                  static_cast<unsigned>(nowMillis));
    activations.push_back(text);
  }
};

// A node with a transfer service, its console and its neighbors.
struct TransferNode {
  RecordingConsole console;
  NeighborTable neighbors;
  RecordingTransferListener listener;
  TransferService transfer;

  explicit TransferNode(uint16_t id) {
    CHECK(transfer.begin(console.events, neighbors, listener, id));
  }
};

static AnnouncedState announcedVersions(uint32_t version, uint32_t available) {
  AnnouncedState state{};
  state.modelKnown = true;
  state.model = BoardModel::HeltecV2;
  state.version = version;
  state.available = available;
  return state;
}

static AnnouncedState announcedVersion(uint32_t version) {
  return announcedVersions(version, version);
}

static const std::string VERSION = std::to_string(SIGNED_IMAGE_VECTOR_VERSION);

J5_HOST_TEST(testTransferLoadImage) {
  TransferNode node(SENDER_ID);
  char detail[ERROR_DETAIL_CAPACITY];
  node.console.output.millis = 100;
  node.transfer.reportTransfer();
  CHECK(node.console.output.text() == R"({"t":100,"ev":"transfer","active":0,"available":0,)"
                                      R"("receiving":null,"missing":null,"fragment_size":231})");
  CHECK(node.transfer.availableProgram().length() == 0);

  // First the format, then the version and last the signature: the available image stays.
  CHECK(node.transfer.loadImage("zz", detail, sizeof(detail)) == ImageLoad::Invalid);
  CHECK(std::strcmp(detail, "format: not hexadecimal") == 0);
  CHECK(node.transfer.loadImage("4a35", detail, sizeof(detail)) == ImageLoad::Invalid);
  CHECK(std::strcmp(detail, "format: shorter than the header") == 0);
  std::string tampered = SIGNED_IMAGE_VECTOR_IMAGE;
  tampered[tampered.size() - 1] = tampered[tampered.size() - 1] == '0' ? '1' : '0';
  CHECK(node.transfer.loadImage(tampered.c_str(), detail, sizeof(detail)) == ImageLoad::Invalid);
  CHECK(std::strncmp(detail, "signature", 9) == 0);
  CHECK(node.transfer.availableVersion() == 0 && node.listener.versionChanges == 0);

  node.console.clear();
  CHECK(node.transfer.loadImage(SIGNED_IMAGE_VECTOR_IMAGE, detail, sizeof(detail)) ==
        ImageLoad::Accepted);
  CHECK(node.console.output.text() ==
        R"({"t":100,"ev":"image","version":)" + VERSION +
            R"(,"size":29,"image_size":102,"via":"console","src":null,"fragments":0,"reports":0,)"
            R"("duration":0})"
            "\nimage v" +
            VERSION + " console");
  CHECK(node.transfer.availableVersion() == SIGNED_IMAGE_VECTOR_VERSION);
  CHECK(node.listener.versionChanges == 1 && node.listener.activations.empty());
  // The program that the VM would load is that of the image.
  uint8_t program[PROGRAM_CAPACITY];
  size_t programLength = 0;
  CHECK(decodeHexBytes(SIGNED_IMAGE_VECTOR_PROGRAM, program, sizeof(program), programLength));
  CHECK(node.transfer.availableProgram().length() == programLength);
  CHECK(std::memcmp(node.transfer.availableProgram().code(), program, programLength) == 0);

  CHECK(node.transfer.loadImage(SIGNED_IMAGE_VECTOR_IMAGE, detail, sizeof(detail)) ==
        ImageLoad::VersionNotNewer);
  CHECK(std::string(detail) == "available version " + VERSION);
  // A malformed image answers invalid_image even if its version is not newer.
  CHECK(node.transfer.loadImage("4a35", detail, sizeof(detail)) == ImageLoad::Invalid);

  node.console.clear();
  node.listener.active = 5;
  node.transfer.reportTransfer();
  CHECK(node.console.output.text() == R"({"t":100,"ev":"transfer","active":5,"available":)" +
                                          VERSION +
                                          R"(,"receiving":null,"missing":null,)"
                                          R"("fragment_size":231})");
}

// The versions of the HELLO messages of the neighbors, on a node connected as on the board.
J5_HOST_TEST(testTransferHello) {
  SimulatedNode node(SENDER_ID);
  SimulatedMedium medium{&node};
  TransferService &transfer = node.services.transfer;
  char detail[ERROR_DETAIL_CAPACITY];
  CHECK(transfer.loadImage(SIGNED_IMAGE_VECTOR_IMAGE, detail, sizeof(detail)) ==
        ImageLoad::Accepted);
  medium.run(100, 120, 10);
  CHECK(!transfer.isBurstInProgress(130));

  // A neighbor that runs the available version activates it, and one that only holds it does not;
  // whether it is newer than the active one is the rule of the activation.
  node.console.clear();
  node.console.output.millis = 300;
  transfer.onNeighborHello(0x00F5, announcedVersions(1, SIGNED_IMAGE_VECTOR_VERSION), 300);
  CHECK(node.console.output.lines.empty());
  transfer.onNeighborHello(0x00F4, announcedVersion(SIGNED_IMAGE_VECTOR_VERSION), 300);
  CHECK(node.eventsNamed({"activation"}) == R"({"t":300,"ev":"activation","version":)" + VERSION +
                                                R"(,"previous":0,"cause":"hello","src":"00F4"})");

  // A neighbor with an older available version gets a full burst, after the HELLO that announces
  // the activation.
  node.console.clear();
  transfer.onNeighborHello(0x00F4, announcedVersion(0), 400);
  CHECK(medium.transmit(node, 400)->description.type == MessageType::Hello);
  CHECK(medium.transmit(node, 410)->description.type == MessageType::Fragment);
  CHECK(node.eventsNamed({"burst_start"}) == R"({"t":410,"ev":"burst_start","version":)" + VERSION +
                                                 R"(,"size":231,"count":1,"cause":"hello",)"
                                                 R"("trigger":"00F4"})");
  CHECK(!transfer.isBurstInProgress(420));
}

J5_HOST_TEST(testTransferRejectedImage) {
  TransferNode node(RECEIVER_ID);
  uint8_t image[MAXIMUM_IMAGE_SIZE];
  size_t imageLength = 0;
  CHECK(decodeHexBytes(SIGNED_IMAGE_VECTOR_IMAGE, image, sizeof(image), imageLength));
  image[imageLength - 1] ^= 0x01;
  FragmentMessage source{};
  source.version = SIGNED_IMAGE_VECTOR_VERSION;
  source.index = 0;
  source.count = 1;
  source.size = DEFAULT_FRAGMENT_SIZE;
  source.remaining = 0;
  source.data = image;
  source.dataLength = imageLength;
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  FragmentMessage fragment{};
  CHECK(decodeFragment(body, encodeFragment(source, body), fragment));

  node.console.output.millis = 500;
  node.transfer.handleFragment(SENDER_ID, fragment, -80.0f, -1.5f, defaultRadioSettings(), 500);
  CHECK(node.console.output.text() ==
        R"({"t":500,"ev":"fragment_rx","src":"3A7F","version":)" + VERSION +
            R"(,"index":0,"count":1,"size":231,"remaining":0,"accepted":true,"new":true,)"
            R"("rssi":-80,"snr":-1.5})"
            "\n"
            R"({"t":500,"ev":"image_rejected","version":)" +
            VERSION +
            R"(,"reason":"signature","src":"3A7F"})"
            "\nimage v" +
            VERSION + " signature");
  CHECK(node.transfer.availableVersion() == 0 && node.listener.versionChanges == 0);
}
