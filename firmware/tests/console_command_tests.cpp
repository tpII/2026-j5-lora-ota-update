// Host tests of the console commands: the words of a line, the argument reader and the dispatch
// through the command table, against the services of a node and a node that records what the
// commands ask of it beyond them.

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "application/console_commands.h"
#include "application/node_services.h"
#include "console/argument_reader.h"
#include "console/command_line.h"
#include "console_line_recorder.h"
#include "generated_test_vectors.h"
#include "host_test_harness.h"
#include "signed_image_builder.h"
#include "simulated_network.h"

using namespace firmware;

static constexpr uint16_t OWN_NODE_ID = 0x1A2B;
// The clock reading of the pass that executes the lines.
static constexpr uint32_t COMMAND_MILLIS = 123456;

// The services of a node on a recording console, and the node itself, which records the actions
// that the commands ask of it.
class CommandTestNode : public CommandTarget {
public:
  bool radioStarted = true;
  RadioSettings settings = defaultRadioSettings();
  std::vector<std::string> actions;
  uint32_t lastMillis = 0;
  SimulatedNode node;
  RecordingConsole &console;
  NodeServices &services;

  explicit CommandTestNode(BoardModel boardModel = BoardModel::HeltecV2)
      : node(OWN_NODE_ID, boardModel), console(node.console), services(node.services) {}

  bool isRadioStarted() const override { return radioStarted; }
  RadioSettings requestedRadioSettings() const override { return settings; }

  void reportStatus(uint32_t nowMillis) override {
    lastMillis = nowMillis;
    actions.push_back("status");
  }
  void reportRadio() override { actions.push_back("radio"); }
  void requestRadioSettings(const RadioSettings &requested) override {
    settings = requested;
    record("radio sf %u bw %u sync %u preamble %u", requested.spreadingFactor,
           requested.bandwidthKhz, requested.syncWord, requested.preambleLength);
  }
  void setWirelessEnabled(bool enabled) override { record("wifi %s", enabled ? "on" : "off"); }

  // Executes the line and returns every console line it wrote.
  const std::vector<std::string> &run(const std::string &text, bool overflowed = false) {
    console.clear();
    actions.clear();
    std::vector<char> line(text.begin(), text.end());
    line.push_back('\0');
    executeCommandLine(line.data(), overflowed, COMMAND_MILLIS,
                       CommandContext{*this, services, console.events});
    return console.output.lines;
  }

  // Executes the line and returns the only event it wrote, or "" for none; the debug text that
  // follows an error is left out.
  std::string execute(const std::string &text, bool overflowed = false) {
    std::vector<std::string> events;
    for (const std::string &line : run(text, overflowed)) {
      if (!line.empty() && line[0] == '{') {
        events.push_back(line);
      }
    }
    return events.size() == 1 ? events[0] : events.empty() ? "" : "several events";
  }

  // Executes the line and returns its only action, or "" when it wrote a console line instead.
  std::string perform(const std::string &text) {
    run(text);
    return console.output.lines.empty() && actions.size() == 1 ? actions[0] : "";
  }

  // The echo request that a line queued, as "echo <id> <size>", or "" for none. The request
  // fails to go out, so the echo of the node no longer waits.
  std::string takeEchoRequest() {
    if (services.queue.isEmpty() ||
        services.queue.next().description.type != MessageType::EchoRequest) {
      return "";
    }
    const QueuedFrame &frame = services.queue.next();
    char text[32];
    std::snprintf(text, sizeof(text), "echo %04X %u", frame.description.destination,
                  static_cast<unsigned>(frame.length - FRAME_OVERHEAD));
    services.recordTransmitFailure();
    return text;
  }

  // Sends a HELLO through the transmitter, so that resend has a frame to repeat. A hold of the
  // HELLO messages ends first.
  void sendFrame() {
    services.presence.release(COMMAND_MILLIS);
    services.presence.requestImmediate();
    SimulatedMedium medium{&node};
    CHECK(medium.transmit(node, COMMAND_MILLIS) != nullptr);
    console.output.millis = 0;
    console.clear();
  }

private:
  template <typename... Values> void record(const char *format, Values... values) {
    char text[64];
    std::snprintf(text, sizeof(text), format, values...);
    actions.push_back(text);
  }
};

static std::string event(const std::string &fields) { return R"({"t":0,)" + fields + "}"; }

static std::string error(const char *command, const char *reason, const char *detail = nullptr) {
  std::string fields =
      std::string(R"("ev":"error","cmd":")") + command + R"(","reason":")" + reason + "\"";
  if (detail != nullptr) {
    fields += std::string(R"(,"detail":")") + detail + "\"";
  }
  return event(fields);
}

// The usage of radio, which help lists.
static const char *const RADIO_USAGE =
    "radio | radio reset | radio <key> <value> ... (freq sf bw cr preamble sync power lna)";

J5_HOST_TEST(testCommandLineWords) {
  char text[] = "  radio  sf 7   bw 500 ";
  const CommandLine line(text);
  CHECK(line.wordCount() == 5);
  CHECK(std::strcmp(line.commandWord(), "radio") == 0 && std::strcmp(line.wordAt(1), "sf") == 0);
  CHECK(std::strcmp(line.wordAt(2), "7") == 0 && std::strcmp(line.wordAt(4), "500") == 0);

  char empty[] = "";
  char spaces[] = "    ";
  CHECK(CommandLine(empty).wordCount() == 0 &&
        std::strcmp(CommandLine(empty).commandWord(), "") == 0);
  CHECK(CommandLine(spaces).wordCount() == 0);

  // Only spaces separate words; a negative number or a tab is part of its word.
  char signs[] = "load_registers -5 -0x10\t1";
  const CommandLine signed_(signs);
  CHECK(signed_.wordCount() == 3 && std::strcmp(signed_.wordAt(1), "-5") == 0);
  CHECK(std::strcmp(signed_.wordAt(2), "-0x10\t1") == 0);

  // Words beyond MAXIMUM_WORDS count but are not kept.
  std::string many = "radio";
  for (size_t index = 0; index < CommandLine::MAXIMUM_WORDS + 3; ++index) {
    many += " x";
  }
  std::vector<char> buffer(many.begin(), many.end());
  buffer.push_back('\0');
  const CommandLine crowded(buffer.data());
  CHECK(crowded.wordCount() == CommandLine::MAXIMUM_WORDS + 4);
  CHECK(std::strcmp(crowded.wordAt(CommandLine::MAXIMUM_WORDS - 1), "x") == 0);
}

J5_HOST_TEST(testArgumentReader) {
  uint64_t number = 0;
  CHECK(parseUnsignedNumber("0", number) && number == 0);
  CHECK(parseUnsignedNumber("007", number) && number == 7);
  CHECK(parseUnsignedNumber("0x1f", number) && number == 31);
  CHECK(parseUnsignedNumber("0XFF", number) && number == 255);
  CHECK(parseUnsignedNumber("4294967295", number) && number == UINT32_MAX);
  // Past 32 bits the value stays above UINT32_MAX, however many digits follow.
  CHECK(parseUnsignedNumber("4294967296", number) && number == uint64_t{UINT32_MAX} + 1);
  CHECK(parseUnsignedNumber("0x123456789ABCDEF0123", number) && number == uint64_t{UINT32_MAX} + 1);
  const char *const notNumbers[] = {"", "-1", "+1", "1.5", "0x", "0x-1", "1e3", "12a", " 1", "x1"};
  for (const char *text : notNumbers) {
    CHECK(!parseUnsignedNumber(text, number));
  }

  int32_t value = 0;
  CHECK(parseRegisterValue("-2147483648", value) && value == INT32_MIN);
  CHECK(parseRegisterValue("-0x80000000", value) && value == INT32_MIN);
  CHECK(parseRegisterValue("4294967295", value) && value == -1);
  CHECK(!parseRegisterValue("-2147483649", value) && !parseRegisterValue("4294967296", value));
  CHECK(!parseRegisterValue("--1", value) && !parseRegisterValue("-", value));

  uint16_t id = 0;
  CHECK(parseNodeIdentifier("3a7F", id) && id == 0x3A7F);
  CHECK(parseNodeIdentifier("F", id) && id == 0x000F);
  CHECK(!parseNodeIdentifier("12345", id) && !parseNodeIdentifier("0x12", id));
  CHECK(!parseNodeIdentifier("", id));

  float fraction = 0.0f;
  CHECK(parseDecimalFraction("915.9", fraction) && fraction == 915.9f);
  CHECK(parseDecimalFraction("915", fraction) && fraction == 915.0f);
  const char *const notFractions[] = {"", ".5", "915.", "-915", "9.1e2", "nan", "0x39", "1.2.3"};
  for (const char *text : notFractions) {
    CHECK(!parseDecimalFraction(text, fraction));
  }

  char detail[ERROR_DETAIL_CAPACITY];
  writeRangeDetail(detail, sizeof(detail), "version", 0, UINT32_MAX);
  CHECK(std::strcmp(detail, "version 0..4294967295") == 0);
}

J5_HOST_TEST(testCommandHelp) {
  CommandTestNode node;
  const std::vector<std::string> expected = {
      "commands:",
      "  help",
      "  status",
      std::string("  ") + RADIO_USAGE,
      "  echo <id> [size]",
      "  run <count> <size> <interval_ms> | run stop",
      "  wifi on|off",
      "  resend",
      "  presence on | presence off <seconds>",
      "  load_registers <r1> <r2> <r3> <r4>",
      "  load_image <hex>",
      "  activate <version>",
      "  fragment_size [bytes]",
      "  program",
  };
  // Text lines on the console only, never on the OLED.
  CHECK(node.run("help") == expected && node.console.output.displayLines.empty());
  CHECK(node.execute("help me") == error("help", "usage", "help"));
}

J5_HOST_TEST(testCommandLineErrors) {
  CommandTestNode node;
  CHECK(node.execute("") == "" && node.actions.empty());
  CHECK(node.execute("   ") == "" && node.actions.empty());
  CHECK(node.execute("frobnicate 1 2") == error("frobnicate", "unknown_command"));
  // Command words are lowercase, and an unknown one is cut to ERROR_COMMAND_WORD_LENGTH characters.
  CHECK(node.execute("STATUS") == error("STATUS", "unknown_command"));
  CHECK(node.execute("abcdefghijklmnopqrstuvwxyz") == error("abcdefghijklmno", "unknown_command"));

  // Every command takes CONSOLE_LINE_CAPACITY characters, and load_image a whole image.
  const std::string status = "status" + std::string(CONSOLE_LINE_CAPACITY - 6, ' ');
  CHECK(node.perform(status) == "status");
  CHECK(node.execute(status + " ") == error("status", "line_too_long"));
  CHECK(node.execute(std::string(CONSOLE_LINE_CAPACITY + 1, 'x')) ==
        error("xxxxxxxxxxxxxxx", "line_too_long"));
  CHECK(node.execute("status", true) == error("status", "line_too_long"));

  // The longest load_image line reaches the image, which is longer than any image.
  const std::string image = "load_image " + std::string(IMAGE_LINE_CAPACITY - 11, 'a');
  CHECK(node.execute(image) ==
        error("load_image", "invalid_image", "format: longer than 1097 bytes"));
  CHECK(node.execute(image + "a") == error("load_image", "line_too_long"));
  CHECK(node.execute(" " + image) == error("load_image", "line_too_long"));
}

J5_HOST_TEST(testCommandUsage) {
  CommandTestNode node;
  const char *const radioUsage = RADIO_USAGE;
  const char *const runUsage = "run <count> <size> <interval_ms> | run stop";
  const char *const presenceUsage = "presence on | presence off <seconds>";
  const char *const echoNode = "echo <id> [size] with the id of another node";

  CHECK(node.execute("status now") == error("status", "usage", "status"));
  CHECK(node.execute("radio sf") == error("radio", "usage", radioUsage));
  CHECK(node.execute("radio sf 7 bw") == error("radio", "usage", radioUsage));
  CHECK(node.execute("echo") == error("echo", "usage", "echo <id> [size]"));
  CHECK(node.execute("echo 3A7F 16 1") == error("echo", "usage", "echo <id> [size]"));
  CHECK(node.execute("echo 3A7F big") == error("echo", "usage", "echo <id> [size]"));
  CHECK(node.execute("echo 3A7F -5") == error("echo", "usage", "echo <id> [size]"));
  CHECK(node.execute("echo 1A2B") == error("echo", "usage", echoNode));
  CHECK(node.execute("echo 0000") == error("echo", "usage", echoNode));
  CHECK(node.execute("echo FFFF") == error("echo", "usage", echoNode));
  CHECK(node.execute("echo 12345") == error("echo", "usage", echoNode));
  CHECK(node.execute("echo 0x12") == error("echo", "usage", echoNode));
  CHECK(node.execute("run") == error("run", "usage", runUsage));
  CHECK(node.execute("run 5") == error("run", "usage", runUsage));
  CHECK(node.execute("run 5 16") == error("run", "usage", runUsage));
  CHECK(node.execute("run -1 16 0") == error("run", "usage", runUsage));
  CHECK(node.execute("run stop 1 2") == error("run", "usage", runUsage));
  CHECK(node.execute("run stop") == error("run", "usage", "no run in progress"));
  CHECK(node.execute("wifi") == error("wifi", "usage", "wifi on|off"));
  CHECK(node.execute("wifi ON") == error("wifi", "usage", "wifi on|off"));
  CHECK(node.execute("resend 1") == error("resend", "usage", "resend"));
  CHECK(node.execute("presence") == error("presence", "usage", presenceUsage));
  CHECK(node.execute("presence off") == error("presence", "usage", presenceUsage));
  CHECK(node.execute("presence on 5") == error("presence", "usage", presenceUsage));
  CHECK(node.execute("presence off -5") == error("presence", "usage", presenceUsage));
  CHECK(node.execute("load_registers 1 2 3") ==
        error("load_registers", "usage", "load_registers <r1> <r2> <r3> <r4>"));
  CHECK(node.execute("load_image") == error("load_image", "usage", "load_image <hex>"));
  CHECK(node.execute("activate") == error("activate", "usage", "activate <version>"));
  CHECK(node.execute("activate +5") == error("activate", "usage", "activate <version>"));
  CHECK(node.execute("fragment_size 64 64") ==
        error("fragment_size", "usage", "fragment_size [bytes]"));
  CHECK(node.execute("program 1") == error("program", "usage", "program"));
  CHECK(node.execute("resend") == error("resend", "usage", "nothing to resend"));
  // Numbers have no sign and no fraction, in every command.
  CHECK(node.execute("run +1 16 0") == error("run", "usage", runUsage));
  CHECK(node.execute("run 1.0 16 0") == error("run", "usage", runUsage));
  CHECK(node.execute("echo 3A7F 0x") == error("echo", "usage", "echo <id> [size]"));
}

J5_HOST_TEST(testCommandOutOfRange) {
  CommandTestNode node;
  CHECK(node.execute("echo 3A7F 3") == error("echo", "out_of_range", "size 4..239"));
  CHECK(node.execute("echo 3A7F 240") == error("echo", "out_of_range", "size 4..239"));
  CHECK(node.execute("run 0 16 0") == error("run", "out_of_range", "count 1..65535"));
  CHECK(node.execute("run 65536 16 0") == error("run", "out_of_range", "count 1..65535"));
  CHECK(node.execute("run 99999999999 16 0") == error("run", "out_of_range", "count 1..65535"));
  CHECK(node.execute("run 1 7 0") == error("run", "out_of_range", "size 8..239"));
  CHECK(node.execute("run 1 16 60001") == error("run", "out_of_range", "interval 0..60000"));
  // The arguments are read in order: the first wrong one is reported.
  CHECK(node.execute("run 0 big 0") == error("run", "out_of_range", "count 1..65535"));
  CHECK(node.execute("presence off 0") == error("presence", "out_of_range", "seconds 1..3600"));
  CHECK(node.execute("presence off 3601") == error("presence", "out_of_range", "seconds 1..3600"));
  CHECK(node.execute("fragment_size 31") ==
        error("fragment_size", "out_of_range", "bytes 32..231"));
  CHECK(node.execute("activate 4294967296") ==
        error("activate", "out_of_range", "version 0..4294967295"));
  const char *const registers = "-2147483648..4294967295 or 0x hexadecimal";
  CHECK(node.execute("load_registers 1 2 3 4294967296") ==
        error("load_registers", "out_of_range", registers));
  CHECK(node.execute("load_registers 1 -2147483649 3 4") ==
        error("load_registers", "out_of_range", registers));
  CHECK(node.execute("load_registers 1 2 0x 4") ==
        error("load_registers", "out_of_range", registers));
  CHECK(node.execute("radio sf 13") == error("radio", "out_of_range", "sf 7..12"));
  // In hexadecimal too, and with more digits than 32 bits hold.
  CHECK(node.execute("run 1 0xF0 0") == error("run", "out_of_range", "size 8..239"));
  CHECK(node.execute("run 0x1FFFFFFFF 16 0") == error("run", "out_of_range", "count 1..65535"));
  CHECK(node.actions.empty());
}

J5_HOST_TEST(testCommandPreconditions) {
  CommandTestNode node;
  CHECK(node.run("run 5 8 100").size() == 2);
  CHECK(node.execute("radio sf 8") == error("radio", "busy"));
  CHECK(node.execute("radio reset") == error("radio", "busy"));
  CHECK(node.execute("echo 3A7F") == error("echo", "busy"));
  // Values are read after the preconditions, word counts before them.
  CHECK(node.execute("echo zz") == error("echo", "busy"));
  CHECK(node.execute("echo") == error("echo", "usage", "echo <id> [size]"));
  CHECK(node.execute("run 1 16 0") == error("run", "busy"));
  CHECK(node.execute("resend") == error("resend", "busy"));
  CHECK(node.perform("radio") == "radio");
  CHECK(node.execute("presence off 5") == event(R"("ev":"presence","state":"off","remaining":5)"));
  CHECK(node.run("run stop").empty() && node.services.runs.isSending());
  node.services.poll(COMMAND_MILLIS);
  CHECK(!node.services.runs.isActive());

  // An echo of this node waits for its reply.
  CHECK(node.run("echo 3A7F").empty());
  CHECK(node.execute("echo 3A7F") == error("echo", "busy"));
  CHECK(node.execute("run 1 16 0") == error("run", "busy"));
  CHECK(node.perform("radio sf 8") == "radio sf 8 bw 500 sync 18 preamble 8");
  CHECK(node.execute("resend") == error("resend", "usage", "nothing to resend"));
  CHECK(node.takeEchoRequest() == "echo 3A7F 16" && !node.services.echo.isPending());

  node.radioStarted = false;
  const char *const notStarted = "radio not started";
  CHECK(node.execute("echo 3A7F") == error("echo", "radio_failure", notStarted));
  CHECK(node.execute("run 1 16 0") == error("run", "radio_failure", notStarted));
  CHECK(node.execute("radio reset") == error("radio", "radio_failure", notStarted));
  CHECK(node.execute("resend") == error("resend", "radio_failure", notStarted));
  CHECK(node.perform("radio") == "radio");
}

J5_HOST_TEST(testCommandNodeActions) {
  CommandTestNode node;
  // The commands that start or report timers get the clock reading of the pass.
  CHECK(node.perform("status") == "status" && node.lastMillis == COMMAND_MILLIS);
  CHECK(node.run("echo 3a7f").empty() && node.takeEchoRequest() == "echo 3A7F 16");
  CHECK(node.run("echo  3A7F  239 ").empty() && node.takeEchoRequest() == "echo 3A7F 239");
  CHECK(node.run("echo 3A7F 0x10").empty() && node.takeEchoRequest() == "echo 3A7F 16");
  CHECK(node.perform("wifi on") == "wifi on" && node.perform("wifi off") == "wifi off");

  // A radio change applies every pair or none, from the requested settings. The values are
  // numbers as every command reads them: decimal, where a leading zero changes nothing, or
  // hexadecimal with 0x.
  CHECK(node.perform("radio sf 9 bw 250") == "radio sf 9 bw 250 sync 18 preamble 8");
  CHECK(node.execute("radio sf 10 bw 300") == error("radio", "out_of_range", "bw 125, 250 or 500"));
  CHECK(node.actions.empty());
  CHECK(node.settings.spreadingFactor == 9 && node.settings.bandwidthKhz == 250);
  CHECK(node.perform("radio sync 0x34 preamble 010") == "radio sf 9 bw 250 sync 52 preamble 10");
  CHECK(node.execute("radio sf -7") == error("radio", "usage", "sf <7..12>"));
  // Each failed pair answers with the reason of its failure.
  CHECK(node.execute("radio power 18") ==
        error("radio", "unreachable_power", "power 2..17 or 20 on V2"));
  CHECK(node.execute("radio lna on") == error("radio", "not_supported", "lna exists only on V4.3"));
  CHECK(node.execute("radio gain 3") == error("radio", "usage", "unknown key gain"));
  CHECK(node.actions.empty());
  CHECK(node.perform("radio reset") == "radio sf 7 bw 500 sync 18 preamble 8");

  // A queue that resend filled refuses the request, which then no longer waits.
  node.sendFrame();
  for (size_t index = 0; index < TRANSMIT_QUEUE_CAPACITY; ++index) {
    CHECK(node.run("resend").empty());
  }
  CHECK(node.execute("echo 3A7F") == error("echo", "busy", "transmit queue full"));
  CHECK(!node.services.echo.isPending());
}

J5_HOST_TEST(testCommandServiceActions) {
  CommandTestNode node;
  CHECK(node.execute("run 65535 239 60000") ==
        event(R"("ev":"run_start","run":1,"count":65535,"size":239,"interval":60000)"));
  CHECK(node.services.runs.isSending());
  CHECK(node.run("run stop").empty());
  node.services.poll(COMMAND_MILLIS);
  CHECK(node.execute("run 1 8 0") ==
        event(R"("ev":"run_start","run":2,"count":1,"size":8,"interval":0)"));
  CHECK(node.run("run stop").empty());
  node.services.poll(COMMAND_MILLIS);
  CHECK(!node.services.runs.isActive());

  CHECK(node.execute("presence on") == event(R"("ev":"presence","state":"on","remaining":null)"));
  CHECK(node.execute("presence off 3600") ==
        event(R"("ev":"presence","state":"off","remaining":3600)"));
  CHECK(node.execute("load_registers -1 0x10 2147483647 4294967295") ==
        event(R"("ev":"vm","version":0,"size":0,"starts":0,"registers":[-1,16,2147483647,-1])"));
  CHECK(node.execute("load_registers -2147483648 0 -0x10 0XfF") ==
        event(R"("ev":"vm","version":0,"size":0,"starts":0,"registers":[-2147483648,0,-16,255])"));
  const std::string transfer =
      R"("ev":"transfer","active":0,"available":0,"receiving":null,"missing":null,)";
  CHECK(node.execute("fragment_size") == event(transfer + R"("fragment_size":231)"));
  CHECK(node.execute("fragment_size 64") == event(transfer + R"("fragment_size":64)"));
  CHECK(node.execute("program") == event(R"("ev":"program","version":0,"size":0,"code":"")"));

  // resend repeats the last frame sent, behind the frames that wait.
  node.sendFrame();
  CHECK(node.run("resend").empty() && !node.services.queue.isEmpty());
  for (size_t index = 1; index < TRANSMIT_QUEUE_CAPACITY; ++index) {
    CHECK(node.run("resend").empty());
  }
  CHECK(node.execute("resend") == error("resend", "busy", "transmit queue full"));

  // An image of the console becomes the available version; activate makes it the active one.
  CHECK(node.execute("load_image zz") ==
        error("load_image", "invalid_image", "format: not hexadecimal"));
  CHECK(node.execute(std::string("load_image ") + SIGNED_IMAGE_VECTOR_IMAGE + "00") ==
        error("load_image", "invalid_image", "format: length does not match the header"));
  // A signed image whose program starts with a byte that is no opcode.
  CHECK(node.execute("load_image " + buildSignedImage(2, "ff")) ==
        error("load_image", "invalid_image", "program: invalid_opcode at 0"));
  node.run(std::string("load_image ") + SIGNED_IMAGE_VECTOR_IMAGE);
  CHECK(node.services.transfer.availableVersion() == SIGNED_IMAGE_VECTOR_VERSION);
  const std::string version = std::to_string(SIGNED_IMAGE_VECTOR_VERSION);
  CHECK(node.execute(std::string("load_image ") + SIGNED_IMAGE_VECTOR_IMAGE) ==
        error("load_image", "version_not_newer", ("available version " + version).c_str()));
  CHECK(node.execute("activate 4") ==
        error("activate", "not_available", ("available version " + version).c_str()));
  CHECK(node.run("activate " + version)[0] ==
        event(R"("ev":"activation","version":)" + version +
              R"(,"previous":0,"cause":"console","src":null)"));
  CHECK(node.services.activation.activeVersion() == SIGNED_IMAGE_VECTOR_VERSION);
  CHECK(node.execute("activate " + version) ==
        error("activate", "version_not_newer", ("active version " + version).c_str()));
}

// The answers of the node to a well-formed line that it refuses for its state: a stop or a resend
// with nothing to act on, an activation with no image available and an image whose signature the
// default key does not verify.
struct StateAnswer {
  const char *reason;
  const char *detailPrefix;
};
static constexpr StateAnswer STATE_ANSWERS[] = {
    {"usage", "no run in progress"},
    {"usage", "nothing to resend"},
    {"not_available", "available version "},
    {"invalid_image", "signature:"},
};

static bool isStateAnswer(const std::string &reason, const std::string &detail) {
  for (const StateAnswer &answer : STATE_ANSWERS) {
    if (reason == answer.reason && detail.rfind(answer.detailPrefix, 0) == 0) {
      return true;
    }
  }
  return false;
}

// Every line that the builders of the control panel produce is accepted by a node of the board
// model it is meant for (firmware/protocol/test-vectors/console-command-lines.jsonl): every error
// it answers counts as a mistake of the builder, except the answers to the state of a fresh node in
// STATE_ANSWERS.
J5_HOST_TEST(testPanelCommandLines) {
  for (const ConsoleCommandLineVector &vector : CONSOLE_COMMAND_LINE_VECTORS) {
    CommandTestNode node(vector.modelKnown ? vector.model : BoardModel::HeltecV2);
    for (const std::string &output : node.run(vector.line)) {
      JsonDocument event;
      if (output.empty() || output[0] != '{' || deserializeJson(event, output) ||
          event["ev"] != "error") {
        continue;
      }
      const bool refused = !isStateAnswer(event["reason"] | "", event["detail"] | "");
      if (refused) {
        std::printf("%s: %.60s answers %s\n", vector.builder, vector.line, output.c_str());
      }
      CHECK(!refused);
    }
  }
}
