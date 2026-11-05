// Host tests of the hardware-independent firmware modules. Run them with run_host_tests.sh.

#include <ArduinoJson.h>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <sodium.h>

#include "configuration.h"
#include "console/console_line_limit.h"
#include "console/event_fields.h"
#include "image/image_verifier.h"
#include "network/byte_order.h"
#include "network/duplicate_filter.h"
#include "radio/time_on_air.h"
#include "services/echo_service.h"
#include "services/presence_service.h"
#include "services/test_run_service.h"
#include "transfer/burst_scheduler.h"
#include "transfer/image_reception.h"
#include "transfer/transfer_messages.h"
#include "vm/virtual_machine.h"

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
  content.available = 9;
  content.vmStatus = encodeVmStatus(VmFault::DivisionByZero, true);
  content.transmitted = 123456;
  content.neighborCount = 2;
  content.neighbors[0] = {0x1234, -45, 9.25f};
  content.neighbors[1] = {0xBEEF, -131, -12.5f};

  uint8_t buffer[255];
  const size_t length = PresenceService::encodePayload(content, buffer);
  CHECK(length == 15 + 2 * HELLO_NEIGHBOR_SIZE);
  // Layout of version 2: model, version, available, vm, transmitted and neighbor count.
  CHECK(buffer[0] == 2 && readUint32(buffer + 1) == 7 && readUint32(buffer + 5) == 9);
  CHECK(buffer[9] == 0x09 && readUint32(buffer + 10) == 123456 && buffer[14] == 2);
  CHECK(readUint16(buffer + 15) == 0x1234);

  HelloContent decoded{};
  CHECK(PresenceService::decodePayload(buffer, length, decoded));
  CHECK(decoded.model == 2 && decoded.version == 7 && decoded.available == 9);
  CHECK(decoded.vmStatus == 0x09 && decoded.transmitted == 123456);
  CHECK(decoded.neighborCount == 2 && decoded.neighbors[1].id == 0xBEEF);
  CHECK(decoded.neighbors[1].rssi == -131 && decoded.neighbors[1].snr == -12.5f);
  CHECK(!PresenceService::decodePayload(buffer, length - 1, decoded));
  CHECK(!PresenceService::decodePayload(buffer, 14, decoded));

  // The vm byte: fault code in bits 0 to 2, bit 3 when the last tick faulted.
  CHECK(encodeVmStatus(VmFault::None, false) == 0x00);
  CHECK(encodeVmStatus(VmFault::TruncatedInstruction, false) == 0x06);
  CHECK(encodeVmStatus(VmFault::EndOfProgram, true) == 0x0B);
  CHECK(vmStatusFault(0xFB) == 3 && isVmStatusFailing(0x08) && !isVmStatusFailing(0x07));
}

static void testImmediateHello() {
  PresenceService presence;
  presence.begin(0);
  CHECK(!presence.isImmediateDue());
  presence.requestImmediate();
  CHECK(presence.isImmediateDue());
  // A hold or a run keeps it waiting; it goes out when the suspension ends.
  presence.hold(10000, 100);
  CHECK(!presence.isImmediateDue() && presence.isInhibited());
  presence.release(200);
  CHECK(presence.isImmediateDue() && !presence.isInhibited());
  presence.setSuspended(true, 300);
  CHECK(!presence.isImmediateDue());
  presence.setSuspended(false, 400);
  CHECK(presence.isImmediateDue());
  presence.scheduleNext(500);
  CHECK(!presence.isImmediateDue());
}

static void testPresenceHold() {
  PresenceService presence;
  presence.begin(0);
  CHECK(presence.isDue(10000));

  // The loop reads the clock at 5000 and the presence command, later in the same pass, at 5001.
  presence.hold(60000, 5001);
  CHECK(presence.isHeld() && !presence.isDue(10000));
  CHECK(!presence.hasHoldExpired(5000));
  CHECK(presence.holdRemainingMillis(5000) == 60000);
  CHECK(presence.holdRemainingMillis(35001) == 30000);
  CHECK(!presence.hasHoldExpired(65000));
  CHECK(presence.hasHoldExpired(65001));

  // Released, the first HELLO comes after the same delay as at boot.
  presence.release(70000);
  CHECK(!presence.isHeld() && presence.holdRemainingMillis(70000) == 0);
  CHECK(!presence.isDue(70000 + FIRST_HELLO_MINIMUM_DELAY_MS - 1));
  CHECK(presence.isDue(70000 + FIRST_HELLO_MAXIMUM_DELAY_MS));

  // A run that ends during a hold does not bring the HELLO back.
  presence.hold(60000, 80000);
  presence.setSuspended(true, 81000);
  presence.setSuspended(false, 82000);
  CHECK(!presence.isDue(90000));
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

// Runs a whole tick and returns how it ended; every PRINT is recorded in order.
static VmStep runTick(VirtualMachine &machine, int32_t *printed = nullptr,
                      size_t *printedCount = nullptr) {
  machine.startTick();
  for (;;) {
    const VmStep step = machine.execute(3);
    if (step == VmStep::Printed && printed != nullptr) {
      printed[(*printedCount)++] = machine.registerValue(machine.printedRegister() - 1);
    }
    if (step == VmStep::Halted || step == VmStep::Faulted || step == VmStep::Idle) {
      return step;
    }
  }
}

static bool loadHex(VirtualMachine &machine, uint32_t version, const char *hex) {
  uint8_t code[PROGRAM_CAPACITY];
  size_t length = 0;
  size_t errorOffset = 0;
  return decodeHexBytes(hex, code, sizeof(code), length) &&
         machine.loadProgram(version, code, length, errorOffset) == ProgramLoad::Accepted;
}

static void testVirtualMachine() {
  VirtualMachine machine;
  machine.begin(100);
  CHECK(machine.version() == 0 && !machine.hasProgram());

  // LOAD R1, 5; LOAD R2, 3; ADDR R1, R2; PRINT R1; SUBI R1, 10; MULR R1, R2; PRINT R1; HALT.
  CHECK(loadHex(machine, 1,
                "020105000000"
                "020203000000"
                "110102"
                "0101"
                "12010a000000"
                "150102"
                "0101"
                "00"));
  int32_t printed[4] = {};
  size_t printedCount = 0;
  CHECK(runTick(machine, printed, &printedCount) == VmStep::Halted);
  CHECK(printedCount == 2 && printed[0] == 8 && printed[1] == -6);
  CHECK(machine.tickNumber() == 1);

  // The registers persist between ticks.
  CHECK(loadHex(machine, 2,
                "100101000000"
                "00"));
  const int32_t zero[REGISTER_COUNT] = {0, 0, 0, 0};
  machine.setRegisters(zero);
  runTick(machine);
  runTick(machine);
  CHECK(machine.registerValue(0) == 2);

  // A version that is not newer, a bad opcode, a bad register and a cut instruction.
  uint8_t code[8] = {0x00};
  size_t errorOffset = 0;
  CHECK(machine.loadProgram(2, code, 1, errorOffset) == ProgramLoad::VersionNotNewer);
  const uint8_t badOpcode[] = {0x01, 0x01, 0x3F};
  CHECK(machine.loadProgram(3, badOpcode, sizeof(badOpcode), errorOffset) ==
        ProgramLoad::Malformed);
  CHECK(errorOffset == 2);
  const uint8_t badRegister[] = {0x11, 0x01, 0x05};
  CHECK(machine.loadProgram(3, badRegister, sizeof(badRegister), errorOffset) ==
        ProgramLoad::Malformed);
  const uint8_t cut[] = {0x02, 0x01, 0x00};
  CHECK(machine.loadProgram(3, cut, sizeof(cut), errorOffset) == ProgramLoad::Malformed);
  CHECK(machine.version() == 2);

  // Wrapping arithmetic, division, modulo, logic and shifts.
  const int32_t values[REGISTER_COUNT] = {INT32_MAX, -7, 2, 0};
  CHECK(loadHex(machine, 3,
                "100101000000" // ADDI R1, 1: wraps to INT32_MIN
                "170203"       // DIVR R2, R3: -7 / 2 = -3
                "190303"       // MODR R3, R3: 0
                "2004ffffffff" // ANDI R4, -1: 0
                "2a04"         // NOT R4: -1
                "280401000000" // SHRI R4, 1: arithmetic, stays -1
                "260321000000" // SHLI R3, 33: masked to 1, 0 << 1 = 0
                "00"));
  machine.setRegisters(values);
  CHECK(runTick(machine) == VmStep::Halted);
  CHECK(machine.registerValue(0) == INT32_MIN);
  CHECK(machine.registerValue(1) == -3);
  CHECK(machine.registerValue(2) == 0);
  CHECK(machine.registerValue(3) == -1);

  // INT32_MIN / -1 wraps instead of trapping.
  CHECK(loadHex(machine, 4,
                "1601ffffffff"
                "00"));
  const int32_t minimum[REGISTER_COUNT] = {INT32_MIN, 0, 0, 0};
  machine.setRegisters(minimum);
  CHECK(runTick(machine) == VmStep::Halted && machine.registerValue(0) == INT32_MIN);

  // Faults end the tick and leave the address of the instruction.
  CHECK(loadHex(machine, 5,
                "0101"
                "160100000000"
                "00"));
  CHECK(runTick(machine) == VmStep::Faulted);
  CHECK(machine.fault() == VmFault::DivisionByZero && machine.faultAddress() == 2);
  CHECK(loadHex(machine, 6, "0101"));
  CHECK(runTick(machine) == VmStep::Faulted && machine.fault() == VmFault::EndOfProgram);

  // The instruction limit stops a tick that never ends.
  VirtualMachine limited;
  limited.begin(3);
  CHECK(loadHex(limited, 1,
                "0101"
                "0101"
                "0101"
                "0101"
                "00"));
  CHECK(runTick(limited) == VmStep::Faulted && limited.fault() == VmFault::InstructionLimit);

  size_t length = 0;
  CHECK(!decodeHexBytes("abc", code, sizeof(code), length));
  CHECK(!decodeHexBytes("zz", code, sizeof(code), length));
  CHECK(!decodeHexBytes("000000000000000000", code, sizeof(code), length));
  CHECK(decodeHexBytes("0aFF", code, sizeof(code), length) && length == 2 && code[1] == 0xFF);
}

static void testVirtualMachineStatus() {
  VirtualMachine machine;
  machine.begin(100);
  CHECK(machine.lastFault() == VmFault::None && !machine.lastTickFaulted());
  // PRINT R1; DIVI R1, 0; HALT: every tick faults.
  CHECK(loadHex(machine, 1,
                "0101"
                "160100000000"
                "00"));
  runTick(machine);
  CHECK(machine.lastFault() == VmFault::DivisionByZero && machine.lastTickFaulted());
  // A tick that ends in HALT clears bit 3 but keeps the last fault.
  const int32_t registers[REGISTER_COUNT] = {1, 2, 3, 4};
  machine.setRegisters(registers);
  CHECK(loadHex(machine, 2, "00"));
  CHECK(machine.lastFault() == VmFault::None && !machine.lastTickFaulted());
  // The load keeps the registers and restarts the tick count.
  CHECK(machine.registerValue(3) == 4 && machine.tickNumber() == 0);
  runTick(machine);
  CHECK(machine.tickNumber() == 1 && !machine.lastTickFaulted());

  size_t errorOffset = 0;
  const uint8_t valid[] = {0x01, 0x01, 0x00};
  const uint8_t cut[] = {0x01, 0x01, 0x02, 0x01};
  CHECK(validateProgram(valid, sizeof(valid), errorOffset));
  CHECK(!validateProgram(cut, sizeof(cut), errorOffset) && errorOffset == 2);
}

static void testConsoleLineLimit() {
  CHECK(consoleLineLimit("status", 6) == CONSOLE_LINE_CAPACITY);
  CHECK(consoleLineLimit("load_image", 10) == CONSOLE_LINE_CAPACITY);
  CHECK(consoleLineLimit("load_image 4a35", 15) == IMAGE_LINE_CAPACITY);
  CHECK(consoleLineLimit("load_program 1", 14) == CONSOLE_LINE_CAPACITY);
  CHECK(consoleLineLimit("load_registers 1 2 3 4", 22) == CONSOLE_LINE_CAPACITY);
  // A whole image of 1097 bytes fits with its command word.
  CHECK(IMAGE_LINE_CAPACITY == 2226 && IMAGE_LINE_CAPACITY >= 11 + 2 * MAXIMUM_IMAGE_SIZE);
}

// ---------------------------------------------------------------------------------------------
// Images and their transfer

// Signed by OpenSSL with keys/default_operator_key.pem, so the control panel can check the same
// bytes.
static const char *VECTOR_PROGRAM = "020105000000020203000000110102010112010a000000150102010100";
static const uint32_t VECTOR_VERSION = 1762300800;
static const char *VECTOR_SIGNED_MESSAGE =
    "4a350080930a691d006684b5a991d2d40592223c279942ecb99a527c"
    "935e7721e1c2fcf0289211505f";
static const char *VECTOR_IMAGE =
    "4a350080930a691d00020105000000020203000000110102010112010a0000001501020101000da5d66cf668f275"
    "63cc61734a4edcb606340c76cc3cd4f8c18d3d986b5fb7642a12459c81095e0b99da5efee4b5d5d009f251901d8d"
    "f4c8597c01e195e8d008";

// Builds and signs an image with a key pair of the test, as the control panel does.
static size_t signImage(const uint8_t *secretKey, uint32_t version, const uint8_t *program,
                        size_t programLength, uint8_t *image) {
  image[0] = IMAGE_MAGIC_FIRST;
  image[1] = IMAGE_MAGIC_SECOND;
  image[2] = 0;
  writeUint32(image + 3, version);
  writeUint16(image + 7, static_cast<uint16_t>(programLength));
  memcpy(image + IMAGE_HEADER_SIZE, program, programLength);
  uint8_t message[IMAGE_SIGNED_MESSAGE_SIZE];
  memcpy(message, image, IMAGE_HEADER_SIZE);
  crypto_hash_sha256(message + IMAGE_HEADER_SIZE, program, programLength);
  crypto_sign_ed25519_detached(image + IMAGE_HEADER_SIZE + programLength, nullptr, message,
                               sizeof(message), secretKey);
  return IMAGE_HEADER_SIZE + programLength + IMAGE_SIGNATURE_SIZE;
}

static void toHex(const uint8_t *bytes, size_t length, char *text) {
  for (size_t index = 0; index < length; ++index) {
    std::snprintf(text + 2 * index, 3, "%02x", bytes[index]);
  }
}

static void testImageVerifier() {
  ImageVerifier verifier;
  CHECK(verifier.begin(DEFAULT_OPERATOR_PUBLIC_KEY));
  CHECK(std::strcmp(J5_OPERATOR_PUBLIC_KEY, DEFAULT_OPERATOR_PUBLIC_KEY) == 0);

  uint8_t image[MAXIMUM_IMAGE_SIZE];
  size_t length = 0;
  CHECK(decodeHexBytes(VECTOR_IMAGE, image, sizeof(image), length) && length == 9 + 29 + 64);
  ImageHeader header{};
  char detail[48];
  CHECK(verifier.verify(image, length, header, detail, sizeof(detail)) == ImageCheck::Valid);
  CHECK(header.version == VECTOR_VERSION && header.programLength == 29 && header.flags == 0);
  uint8_t program[PROGRAM_CAPACITY];
  size_t programLength = 0;
  CHECK(decodeHexBytes(VECTOR_PROGRAM, program, sizeof(program), programLength));
  CHECK(programLength == 29 && std::memcmp(image + 9, program, programLength) == 0);

  // The signed message is the header followed by the SHA-256 of the program.
  uint8_t message[IMAGE_SIGNED_MESSAGE_SIZE];
  memcpy(message, image, IMAGE_HEADER_SIZE);
  crypto_hash_sha256(message + IMAGE_HEADER_SIZE, program, programLength);
  char messageHex[2 * IMAGE_SIGNED_MESSAGE_SIZE + 1];
  toHex(message, sizeof(message), messageHex);
  CHECK(std::strcmp(messageHex, VECTOR_SIGNED_MESSAGE) == 0);

  // Any changed byte of the program or of the signature breaks the signature.
  uint8_t tampered[MAXIMUM_IMAGE_SIZE];
  memcpy(tampered, image, length);
  tampered[IMAGE_HEADER_SIZE + 5] ^= 0x01;
  CHECK(verifier.verify(tampered, length, header, detail, sizeof(detail)) == ImageCheck::Signature);
  CHECK(std::strncmp(detail, "signature", 9) == 0);
  memcpy(tampered, image, length);
  tampered[length - 1] ^= 0x80;
  CHECK(verifier.verify(tampered, length, header, detail, sizeof(detail)) == ImageCheck::Signature);
  // So does a version changed in the header.
  memcpy(tampered, image, length);
  tampered[3] ^= 0x01;
  CHECK(verifier.verify(tampered, length, header, detail, sizeof(detail)) == ImageCheck::Signature);

  // Format: magic, flags, version 0, lengths.
  memcpy(tampered, image, length);
  tampered[0] = 0x4B;
  CHECK(verifier.verify(tampered, length, header, detail, sizeof(detail)) == ImageCheck::Format);
  CHECK(std::strncmp(detail, "format", 6) == 0);
  memcpy(tampered, image, length);
  tampered[2] = 1;
  CHECK(verifier.verify(tampered, length, header, detail, sizeof(detail)) == ImageCheck::Format);
  memcpy(tampered, image, length);
  writeUint32(tampered + 3, 0);
  CHECK(verifier.verify(tampered, length, header, detail, sizeof(detail)) == ImageCheck::Format);
  CHECK(verifier.verify(image, length - 1, header, detail, sizeof(detail)) == ImageCheck::Format);
  CHECK(verifier.verify(image, 8, header, detail, sizeof(detail)) == ImageCheck::Format);

  // Another key rejects the image of the default key.
  uint8_t publicKey[crypto_sign_ed25519_PUBLICKEYBYTES];
  uint8_t secretKey[crypto_sign_ed25519_SECRETKEYBYTES];
  crypto_sign_ed25519_keypair(publicKey, secretKey);
  char publicKeyHex[2 * OPERATOR_PUBLIC_KEY_SIZE + 1];
  toHex(publicKey, sizeof(publicKey), publicKeyHex);
  ImageVerifier other;
  CHECK(other.begin(publicKeyHex));
  CHECK(other.verify(image, length, header, detail, sizeof(detail)) == ImageCheck::Signature);

  // A well signed image whose program fails the VM validation: unknown opcode at address 2.
  const uint8_t badProgram[] = {0x01, 0x01, 0x3F, 0x00};
  const size_t badLength = signImage(secretKey, 5, badProgram, sizeof(badProgram), tampered);
  CHECK(other.verify(tampered, badLength, header, detail, sizeof(detail)) == ImageCheck::Program);
  CHECK(std::strcmp(detail, "program: bad instruction at 2") == 0);

  // The largest program fits, one more byte does not.
  uint8_t largest[PROGRAM_CAPACITY];
  memset(largest, 0x00, sizeof(largest));
  CHECK(signImage(secretKey, 6, largest, sizeof(largest), tampered) == MAXIMUM_IMAGE_SIZE);
  CHECK(other.verify(tampered, MAXIMUM_IMAGE_SIZE, header, detail, sizeof(detail)) ==
        ImageCheck::Valid);

  // The two halves of verify: the format alone does not look at the signature or the program.
  CHECK(other.checkFormat(image, length, header, detail, sizeof(detail)) == ImageCheck::Valid);
  CHECK(header.version == VECTOR_VERSION);
  CHECK(other.checkSignatureAndProgram(image, header, detail, sizeof(detail)) ==
        ImageCheck::Signature);
  CHECK(verifier.checkFormat(image, 8, header, detail, sizeof(detail)) == ImageCheck::Format);
  CHECK(verifier.checkFormat(image, length, header, detail, sizeof(detail)) == ImageCheck::Valid);
  CHECK(verifier.checkSignatureAndProgram(image, header, detail, sizeof(detail)) ==
        ImageCheck::Valid);

  ImageVerifier broken;
  CHECK(!broken.begin("9b82"));
  CHECK(broken.verify(image, length, header, detail, sizeof(detail)) == ImageCheck::Signature);
  CHECK(std::strcmp(imageCheckName(ImageCheck::Program), "program") == 0);
}

// Encodes a fragment of the image and decodes it again, as a receiver would.
static bool makeFragment(const uint8_t *image, size_t imageLength, uint32_t version, uint8_t size,
                         uint8_t index, uint8_t remaining, uint8_t *body, FragmentFields &fields) {
  FragmentFields source{};
  source.version = version;
  source.index = index;
  source.count = fragmentCountFor(imageLength, size);
  source.size = size;
  source.remaining = remaining;
  const size_t offset = static_cast<size_t>(index) * size;
  source.data = image + offset;
  source.dataLength = imageLength - offset < size ? imageLength - offset : size;
  const size_t length = encodeFragment(source, body);
  return decodeFragment(body, length, fields);
}

static bool decodeRawFragment(uint32_t version, uint8_t index, uint8_t count, uint8_t size,
                              uint8_t remaining, size_t dataLength) {
  uint8_t body[MAXIMUM_PAYLOAD_SIZE + 8] = {};
  writeUint32(body, version);
  body[4] = index;
  body[5] = count;
  body[6] = size;
  body[7] = remaining;
  FragmentFields fields{};
  return decodeFragment(body, FRAGMENT_HEADER_SIZE + dataLength, fields);
}

static void testFragmentMessages() {
  uint8_t image[200];
  for (size_t index = 0; index < sizeof(image); ++index) {
    image[index] = static_cast<uint8_t>(index);
  }
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  FragmentFields fields{};
  // 200 bytes in fragments of 64: 64, 64, 64 and 8.
  CHECK(makeFragment(image, sizeof(image), 77, 64, 3, 0, body, fields));
  CHECK(readUint32(body) == 77 && body[4] == 3 && body[5] == 4 && body[6] == 64 && body[7] == 0);
  CHECK(fields.dataLength == 8 && fields.data[0] == 192);

  // Size from 32 to 231 bytes.
  CHECK(decodeRawFragment(1, 0, 3, 32, 2, 32));
  CHECK(!decodeRawFragment(1, 0, 3, 31, 2, 31));
  CHECK(decodeRawFragment(1, 0, 1, 231, 0, 100));
  CHECK(!decodeRawFragment(1, 0, 1, 232, 0, 100));
  CHECK(!decodeRawFragment(0, 0, 3, 32, 2, 32));
  // Index and remaining below count.
  CHECK(!decodeRawFragment(1, 3, 3, 32, 0, 10));
  CHECK(!decodeRawFragment(1, 0, 3, 32, 3, 32));
  // count x size reaches 74 bytes; (count - 1) x size stays below 1097.
  CHECK(!decodeRawFragment(1, 0, 2, 32, 0, 32));
  CHECK(decodeRawFragment(1, 0, 3, 32, 0, 32));
  CHECK(decodeRawFragment(1, 34, 35, 32, 0, 9));
  CHECK(!decodeRawFragment(1, 35, 36, 32, 0, 1));
  // Data: exactly size bytes but in the last fragment, which holds 1 to size.
  CHECK(!decodeRawFragment(1, 0, 3, 32, 0, 31));
  CHECK(!decodeRawFragment(1, 0, 3, 32, 0, 33));
  CHECK(decodeRawFragment(1, 2, 3, 32, 0, 1));
  CHECK(!decodeRawFragment(1, 2, 3, 32, 0, 0));
  CHECK(!decodeRawFragment(1, 2, 3, 32, 0, 33));
  // The last fragment does not carry the image past 1097 bytes: 4 x 231 + 173 = 1097.
  CHECK(decodeRawFragment(1, 4, 5, 231, 0, 173));
  CHECK(!decodeRawFragment(1, 4, 5, 231, 0, 174));
  CHECK(!decodeRawFragment(1, 4, 5, 231, 0, 231));
  // A last fragment that leaves the image below 74 bytes is a valid body.
  CHECK(decodeRawFragment(1, 0, 1, 231, 0, 50));
  CHECK(decodeRawFragment(1, 1, 2, 40, 0, 10));
}

static void testReportMessages() {
  ReportFields report{};
  report.version = 0x01020304;
  report.size = 32;
  report.count = 10;
  markFragment(report, 0);
  markFragment(report, 8);
  markFragment(report, 9);
  // Fragment i is bit i mod 8, least significant first, of byte i / 8.
  CHECK(report.missing[0] == 0x01 && report.missing[1] == 0x03);
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  report.missing[1] |= 0x80; // a bit past the count goes out as 0
  CHECK(encodeReport(report, body) == 8);
  CHECK(readUint32(body) == 0x01020304 && body[4] == 32 && body[5] == 10);
  CHECK(body[6] == 0x01 && body[7] == 0x03);

  ReportFields decoded{};
  CHECK(decodeReport(body, 8, decoded));
  CHECK(decoded.count == 10 && isFragmentMarked(decoded, 9) && !isFragmentMarked(decoded, 1));
  CHECK(!decodeReport(body, 7, decoded));
  CHECK(!decodeReport(body, 9, decoded));
  body[5] = 0;
  CHECK(!decodeReport(body, 6, decoded));
  body[5] = 35;
  CHECK(decodeReport(body, 11, decoded));
  body[5] = 36;
  CHECK(!decodeReport(body, 11, decoded));
  body[5] = 8;
  CHECK(decodeReport(body, 7, decoded));
  body[4] = 31;
  CHECK(!decodeReport(body, 7, decoded));
  body[4] = 231;
  writeUint32(body, 0);
  CHECK(!decodeReport(body, 7, decoded));
}

static void testReceptionCoverage() {
  // The image of the test vector, 102 bytes: in fragments of 32 bytes, 32, 32, 32 and 6.
  uint8_t image[MAXIMUM_IMAGE_SIZE];
  size_t imageLength = 0;
  decodeHexBytes(VECTOR_IMAGE, image, sizeof(image), imageLength);
  const uint32_t version = VECTOR_VERSION;
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  FragmentFields fields{};

  ImageReception reception;
  reception.reset();
  CHECK(!reception.isActive());
  makeFragment(image, imageLength, version, 32, 2, 1, body, fields);
  FragmentReceipt receipt = reception.offer(0x3A7F, fields, 1000, 20);
  CHECK(receipt.accepted && receipt.contributed && receipt.started);
  CHECK(reception.isActive() && reception.version() == version && !reception.isLengthKnown());
  // While the length is unknown, the missing bytes count up to 4 x 32.
  CHECK(reception.missingByteCount() == 128 - 32);

  // Out of order, and a repeated fragment adds nothing.
  makeFragment(image, imageLength, version, 32, 0, 0, body, fields);
  receipt = reception.offer(0x3A7F, fields, 1010, 20);
  CHECK(receipt.accepted && receipt.contributed && !receipt.started);
  receipt = reception.offer(0x3A7F, fields, 1020, 20);
  CHECK(receipt.accepted && !receipt.contributed);

  // The report marks fragment 1 and the last one, whose length is still unknown.
  ReportFields report{};
  reception.buildReport(report);
  CHECK(report.version == version && report.size == 32 && report.count == 4);
  CHECK(report.missing[0] == 0x0A);

  // The last fragment gives the exact length.
  makeFragment(image, imageLength, version, 32, 3, 0, body, fields);
  reception.offer(0x3A7F, fields, 1030, 20);
  CHECK(reception.isLengthKnown() && reception.imageLength() == imageLength);
  CHECK(reception.missingByteCount() == 32 && !reception.isComplete());
  reception.buildReport(report);
  CHECK(report.missing[0] == 0x02);

  // A fragment of another size fills the gap: bytes 0 to 63 in fragments of 64.
  makeFragment(image, imageLength, version, 64, 0, 0, body, fields);
  receipt = reception.offer(0x00F4, fields, 1040, 30);
  CHECK(receipt.accepted && receipt.contributed && reception.isComplete());
  CHECK(std::memcmp(reception.image(), image, imageLength) == 0);
  CHECK(reception.missingByteCount() == 0 && reception.fragmentCount() == 5);
  CHECK(reception.lastSource() == 0x00F4);
  ImageVerifier verifier;
  verifier.begin(DEFAULT_OPERATOR_PUBLIC_KEY);
  ImageHeader header{};
  char detail[48];
  CHECK(verifier.verify(reception.image(), reception.imageLength(), header, detail,
                        sizeof(detail)) == ImageCheck::Valid);

  // Mixed sizes from the start: the last fragment of 64 and the two first of 32.
  reception.reset();
  makeFragment(image, imageLength, version, 64, 1, 0, body, fields);
  reception.offer(0x3A7F, fields, 0, 30);
  CHECK(reception.isLengthKnown() && reception.missingByteCount() == 64);
  makeFragment(image, imageLength, version, 32, 0, 1, body, fields);
  reception.offer(0x3A7F, fields, 0, 20);
  makeFragment(image, imageLength, version, 32, 1, 0, body, fields);
  reception.offer(0x3A7F, fields, 0, 20);
  CHECK(reception.isComplete());

  // A fragment that contradicts the known length restarts the reception with it.
  reception.reset();
  makeFragment(image, imageLength, version, 32, 3, 0, body, fields);
  reception.offer(0x3A7F, fields, 0, 20);
  makeFragment(image, imageLength, version, 32, 0, 0, body, fields);
  reception.offer(0x3A7F, fields, 0, 20);
  uint8_t longer[MAXIMUM_IMAGE_SIZE];
  memcpy(longer, image, imageLength);
  makeFragment(longer, imageLength + 10, version, 32, 3, 0, body, fields);
  receipt = reception.offer(0x3A7F, fields, 0, 20);
  CHECK(receipt.accepted && receipt.started && reception.fragmentCount() == 1);
  CHECK(reception.imageLength() == imageLength + 10 && reception.missingByteCount() == 96);
  // A non-last fragment of 64 bytes leaves the length between 65 and 128: no contradiction.
  makeFragment(longer, imageLength + 10, version, 64, 0, 1, body, fields);
  receipt = reception.offer(0x3A7F, fields, 0, 20);
  CHECK(receipt.accepted && !receipt.started);

  // A newer version replaces the reception; an older one is ignored.
  makeFragment(image, imageLength, version + 1, 32, 0, 3, body, fields);
  receipt = reception.offer(0x3A7F, fields, 0, 20);
  CHECK(receipt.started && reception.version() == version + 1);
  makeFragment(image, imageLength, version, 32, 1, 2, body, fields);
  receipt = reception.offer(0x3A7F, fields, 0, 20);
  CHECK(!receipt.accepted && reception.version() == version + 1);

  // A last fragment that ends past the largest image is an invalid body; offered all the same,
  // it fits no image and leaves the reception untouched.
  reception.reset();
  CHECK(!decodeRawFragment(9, 4, 5, 231, 0, 231));
  uint8_t filler[MAXIMUM_PAYLOAD_SIZE] = {};
  fields = FragmentFields{};
  fields.version = 9;
  fields.index = 4;
  fields.count = 5;
  fields.size = 231;
  fields.data = filler;
  fields.dataLength = 231;
  receipt = reception.offer(0x3A7F, fields, 0, 20);
  CHECK(!receipt.accepted && !reception.isActive());

  // A last fragment that leaves the image below 74 bytes belongs to the reception: the bytes
  // complete and the verification rejects the image for format.
  reception.reset();
  makeFragment(image, 50, version, 231, 0, 0, body, fields);
  receipt = reception.offer(0x3A7F, fields, 0, 20);
  CHECK(receipt.accepted && receipt.started && reception.isComplete());
  CHECK(reception.imageLength() == 50);
  CHECK(verifier.verify(reception.image(), reception.imageLength(), header, detail,
                        sizeof(detail)) == ImageCheck::Format);
  // In a reception in progress it contradicts the known length and restarts it.
  reception.reset();
  makeFragment(image, imageLength, version, 32, 0, 3, body, fields);
  reception.offer(0x3A7F, fields, 0, 20);
  makeFragment(image, 50, version, 40, 1, 0, body, fields);
  CHECK(fields.count == 2 && fields.dataLength == 10);
  receipt = reception.offer(0x3A7F, fields, 0, 20);
  CHECK(receipt.accepted && receipt.started && reception.isLengthKnown());
  CHECK(reception.imageLength() == 50 && reception.fragmentCount() == 1);
  // Before its last fragment arrives, the length of an image is unknown even when count x size
  // is 74.
  reception.reset();
  makeFragment(image, 74, version, 37, 0, 1, body, fields);
  reception.offer(0x3A7F, fields, 0, 20);
  CHECK(!reception.isLengthKnown());
}

static void testReceptionDeadlines() {
  uint8_t image[MAXIMUM_IMAGE_SIZE];
  size_t imageLength = 0;
  decodeHexBytes(VECTOR_IMAGE, image, sizeof(image), imageLength);
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  FragmentFields fields{};
  ImageReception reception;
  reception.reset();

  // Three fragments still to come, 20 ms each: the burst ends 60 ms plus the margin later.
  makeFragment(image, imageLength, 1, 32, 0, 3, body, fields);
  reception.offer(0x3A7F, fields, 1000, 20);
  CHECK(reception.isBurstInProgress(1000) && !reception.isReportDue(1000));
  CHECK(reception.isBurstInProgress(1000 + 60 + TRANSFER_MARGIN_MS - 1));
  CHECK(!reception.isReportDue(1000 + 60 + TRANSFER_MARGIN_MS - 1));
  CHECK(!reception.isBurstInProgress(1000 + 60 + TRANSFER_MARGIN_MS));
  CHECK(reception.isReportDue(1000 + 60 + TRANSFER_MARGIN_MS));

  // The report goes out; without fragments it is repeated after the timeout.
  reception.onReportSent(2000, 540);
  CHECK(reception.reportCount() == 1 && !reception.isBurstInProgress(2000));
  CHECK(!reception.isReportDue(2539) && reception.isReportDue(2540));
  reception.onReportSent(2540, 540);
  CHECK(reception.reportCount() == 2 && !reception.isReportDue(2541));

  // A fragment re-arms the burst deadline; the last of the burst asks for a report at once.
  makeFragment(image, imageLength, 1, 32, 1, 1, body, fields);
  reception.offer(0x3A7F, fields, 2600, 20);
  CHECK(reception.isBurstInProgress(2600) && !reception.isReportDue(3000));
  makeFragment(image, imageLength, 1, 32, 3, 0, body, fields);
  reception.offer(0x3A7F, fields, 2620, 20);
  CHECK(!reception.isBurstInProgress(2620) && reception.isReportDue(2620));
  ReportFields report{};
  reception.buildReport(report);
  CHECK(report.missing[0] == 0x04);
  // Complete: no report is due any more.
  makeFragment(image, imageLength, 1, 32, 2, 0, body, fields);
  reception.offer(0x3A7F, fields, 2640, 20);
  CHECK(reception.isComplete() && !reception.isReportDue(2640));
  CHECK(!reception.isBurstInProgress(2640));
  // Across the wrap of millis().
  reception.reset();
  makeFragment(image, imageLength, 1, 32, 0, 1, body, fields);
  reception.offer(0x3A7F, fields, 0xFFFFFF00u, 20);
  CHECK(reception.isBurstInProgress(0xFFFFFF00u + 519) && !reception.isReportDue(0x10u));
  CHECK(reception.isReportDue(0xFFFFFF00u + 520));
}

// Sends the next fragment of the scheduler and returns its index, or -1 when none is due.
static int sendNextFragment(BurstScheduler &bursts, bool &started, uint8_t &remaining,
                            bool &finished) {
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  const size_t length = bursts.buildNextFragment(body, started);
  if (length == 0) {
    return -1;
  }
  remaining = body[7];
  bursts.onFragmentStarted(2000);
  finished = bursts.onFragmentSent(readUint32(body), 2100);
  return body[4];
}

static void testBurstScheduler() {
  uint8_t image[MAXIMUM_IMAGE_SIZE];
  for (size_t index = 0; index < sizeof(image); ++index) {
    image[index] = static_cast<uint8_t>(index * 7);
  }
  const size_t imageLength = 102;
  BurstScheduler bursts;
  bursts.setImage(image, imageLength, 7);
  CHECK(!bursts.hasBurst() && !bursts.isFragmentDue());

  // A full burst: 4 fragments of 32 bytes in index order, with the fragments left.
  CHECK(bursts.requestFullBurst(32, BurstCause::Load, 0));
  CHECK(bursts.currentBurst().count == 4 && !bursts.hasStartedBurst());
  bool started = false;
  bool finished = false;
  uint8_t remaining = 0;
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  CHECK(bursts.buildNextFragment(body, started) == FRAGMENT_HEADER_SIZE + 32);
  CHECK(started && body[4] == 0 && body[5] == 4 && body[6] == 32 && body[7] == 3);
  CHECK(body[FRAGMENT_HEADER_SIZE + 1] == 7);
  CHECK(bursts.currentBurst().initialCount == 4 && !bursts.isFragmentDue());
  bursts.onFragmentStarted(1000);
  CHECK(!bursts.onFragmentSent(7, 1500));
  CHECK(sendNextFragment(bursts, started, remaining, finished) == 1 && !started && !finished);

  // A report of the same size adds its fragments to the burst in progress.
  ReportFields report{};
  report.version = 7;
  report.size = 32;
  report.count = 4;
  markFragment(report, 0);
  CHECK(bursts.mergeReport(report, 0x00F4));
  CHECK(sendNextFragment(bursts, started, remaining, finished) == 0 && remaining == 2);
  CHECK(sendNextFragment(bursts, started, remaining, finished) == 2 && remaining == 1);
  // A report of another size waits as a burst of its own.
  ReportFields other{};
  other.version = 7;
  other.size = 64;
  other.count = 2;
  markFragment(other, 1);
  CHECK(bursts.mergeReport(other, 0x00F4));
  CHECK(sendNextFragment(bursts, started, remaining, finished) == 3 && remaining == 0);
  CHECK(finished && bursts.currentBurst().sent == 5);
  // From the start of the first fragment to the end of the last one.
  CHECK(bursts.currentBurst().lastEndMicros - bursts.currentBurst().firstStartMicros == 1100);
  bursts.finishBurst();
  CHECK(bursts.hasBurst() && bursts.currentBurst().cause == BurstCause::Report);
  CHECK(bursts.currentBurst().trigger == 0x00F4 && bursts.currentBurst().size == 64);
  CHECK(sendNextFragment(bursts, started, remaining, finished) == 1 && started && finished);
  CHECK(bursts.currentBurst().initialCount == 1);
  bursts.finishBurst();
  CHECK(!bursts.hasBurst());

  // Ignored reports: another version, a count that does not match, nothing marked.
  report.version = 6;
  CHECK(!bursts.mergeReport(report, 0x00F4));
  report.version = 7;
  report.count = 5;
  CHECK(!bursts.mergeReport(report, 0x00F4));
  ReportFields empty{};
  empty.version = 7;
  empty.size = 32;
  empty.count = 4;
  CHECK(!bursts.mergeReport(empty, 0x00F4));
  CHECK(!bursts.hasBurst());

  // A report with no burst in progress starts one.
  report.count = 4;
  CHECK(bursts.mergeReport(report, 0x1234) && bursts.currentBurst().cause == BurstCause::Report);

  // A new image drops the bursts of the previous one; the fragment on the air only frees the
  // transmitter.
  CHECK(bursts.buildNextFragment(body, started) > 0);
  bursts.setImage(image, 300, 8);
  CHECK(!bursts.hasBurst());
  CHECK(bursts.requestFullBurst(231, BurstCause::Complete, 0));
  CHECK(!bursts.isFragmentDue());
  CHECK(!bursts.onFragmentSent(7, 300));
  CHECK(bursts.isFragmentDue() && bursts.currentBurst().count == 2);
  CHECK(bursts.buildNextFragment(body, started) == FRAGMENT_HEADER_SIZE + 231);
  // A failed fragment is not sent again.
  CHECK(!bursts.onFragmentFailed(8));
  CHECK(bursts.buildNextFragment(body, started) == FRAGMENT_HEADER_SIZE + 69 && body[4] == 1);
  CHECK(bursts.onFragmentFailed(8) && bursts.currentBurst().sent == 0);

  // The queue holds BURST_QUEUE_CAPACITY bursts.
  bursts.setImage(image, imageLength, 9);
  for (size_t index = 0; index < BURST_QUEUE_CAPACITY; ++index) {
    CHECK(bursts.requestFullBurst(32, BurstCause::Hello, 0x1234));
  }
  CHECK(!bursts.requestFullBurst(32, BurstCause::Hello, 0x1234));
  CHECK(std::strcmp(burstCauseName(BurstCause::Complete), "complete") == 0);
}

int main() {
  if (sodium_init() < 0) {
    std::printf("libsodium did not start.\n");
    return 1;
  }
  testTimeOnAir();
  testDuplicateFilter();
  testHelloPayload();
  testPresenceHold();
  testEchoPayload();
  testEchoDeadline();
  testTestRuns();
  testEventFields();
  testImmediateHello();
  testVirtualMachine();
  testVirtualMachineStatus();
  testConsoleLineLimit();
  testImageVerifier();
  testFragmentMessages();
  testReportMessages();
  testReceptionCoverage();
  testReceptionDeadlines();
  testBurstScheduler();
  if (failureCount == 0) {
    std::printf("All host tests passed.\n");
    return 0;
  }
  std::printf("%d host test checks failed.\n", failureCount);
  return 1;
}
