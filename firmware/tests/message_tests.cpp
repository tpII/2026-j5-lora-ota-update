// Host tests of the wire codecs: each message round trips through its codec and a malformed body
// is rejected, and the reception pipeline decodes each body with the codec of its type.

#include <cstring>

#include "encoding/byte_order.h"
#include "host_test_harness.h"
#include "messages/echo_message.h"
#include "messages/fragment_message.h"
#include "messages/hello_message.h"
#include "messages/message_body.h"
#include "messages/report_message.h"
#include "messages/test_message.h"

using namespace firmware;

J5_HOST_TEST(testHelloMessage) {
  HelloMessage message{};
  message.announced.modelKnown = true;
  message.announced.model = BoardModel::HeltecV43;
  message.announced.version = 7;
  message.announced.available = 9;
  message.announced.lastFault = VmFault::DivisionByZero;
  message.announced.vmFailing = true;
  message.announced.transmitted = 123456;
  message.neighborCount = 2;
  message.neighbors[0] = {0x1234, -45, 9.25f};
  message.neighbors[1] = {0xBEEF, -131, -12.5f};

  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  const size_t length = encodeHello(message, body);
  CHECK(length == HELLO_FIXED_SIZE + 2 * HELLO_NEIGHBOR_SIZE);
  CHECK(body[HELLO_MODEL_OFFSET] == static_cast<uint8_t>(BoardModel::HeltecV43));
  CHECK(readUint32(body + HELLO_VERSION_OFFSET) == 7);
  CHECK(readUint32(body + HELLO_AVAILABLE_OFFSET) == 9);
  // The byte vm: the fault code in the mask, the failing bit when the last tick faulted.
  CHECK(body[HELLO_VM_STATUS_OFFSET] ==
        (static_cast<uint8_t>(VmFault::DivisionByZero) | VM_STATUS_FAILING_BIT));
  CHECK(readUint32(body + HELLO_TRANSMITTED_OFFSET) == 123456);
  CHECK(body[HELLO_NEIGHBOR_COUNT_OFFSET] == 2);
  CHECK(readUint16(body + HELLO_FIXED_SIZE + HELLO_NEIGHBOR_ID_OFFSET) == 0x1234);

  HelloMessage decoded{};
  CHECK(decodeHello(body, length, decoded));
  const AnnouncedState &announced = decoded.announced;
  CHECK(announced.modelKnown && announced.model == BoardModel::HeltecV43);
  CHECK(announced.version == 7 && announced.available == 9 && announced.transmitted == 123456);
  CHECK(announced.lastFault == VmFault::DivisionByZero && announced.vmFailing);
  CHECK(decoded.neighborCount == 2 && decoded.neighbors[0].id == 0x1234);
  CHECK(decoded.neighbors[0].rssi == -45 && decoded.neighbors[0].snr == 9.25f);
  CHECK(decoded.neighbors[1].id == 0xBEEF);
  CHECK(decoded.neighbors[1].rssi == -131 && decoded.neighbors[1].snr == -12.5f);

  // The length must match the neighbor count, and the count stays within MAXIMUM_NEIGHBORS.
  CHECK(!decodeHello(body, length - 1, decoded));
  CHECK(!decodeHello(body, length + HELLO_NEIGHBOR_SIZE, decoded));
  CHECK(!decodeHello(body, HELLO_FIXED_SIZE - 1, decoded));
  uint8_t full[MAXIMUM_PAYLOAD_SIZE] = {};
  full[HELLO_NEIGHBOR_COUNT_OFFSET] = MAXIMUM_NEIGHBORS;
  CHECK(decodeHello(full, MAXIMUM_HELLO_SIZE, decoded));
  full[HELLO_NEIGHBOR_COUNT_OFFSET] = MAXIMUM_NEIGHBORS + 1;
  CHECK(!decodeHello(full, MAXIMUM_HELLO_SIZE + HELLO_NEIGHBOR_SIZE, decoded));
  // A HELLO never lists more than MAXIMUM_NEIGHBORS.
  message.neighborCount = MAXIMUM_NEIGHBORS + 3;
  CHECK(encodeHello(message, full) == MAXIMUM_HELLO_SIZE);
}

J5_HOST_TEST(testHelloVirtualMachineStatus) {
  HelloMessage message{};
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  HelloMessage decoded{};
  // Every fault round trips, with and without the failing bit.
  for (size_t code = 0; code < VM_FAULT_COUNT; ++code) {
    for (int failing = 0; failing < 2; ++failing) {
      message.announced.lastFault = static_cast<VmFault>(code);
      message.announced.vmFailing = failing != 0;
      CHECK(decodeHello(body, encodeHello(message, body), decoded));
      CHECK(decoded.announced.lastFault == message.announced.lastFault);
      CHECK(decoded.announced.vmFailing == (failing != 0));
    }
  }
  // Reserved bits are ignored, and a code outside the contract reads as no fault.
  const uint8_t reservedBits =
      static_cast<uint8_t>(~(VM_STATUS_FAULT_MASK | VM_STATUS_FAILING_BIT));
  body[HELLO_VM_STATUS_OFFSET] = reservedBits | static_cast<uint8_t>(VmFault::EndOfProgram);
  CHECK(decodeHello(body, HELLO_FIXED_SIZE, decoded));
  CHECK(decoded.announced.lastFault == VmFault::EndOfProgram && !decoded.announced.vmFailing);
  body[HELLO_VM_STATUS_OFFSET] = VM_STATUS_FAULT_MASK | VM_STATUS_FAILING_BIT;
  CHECK(decodeHello(body, HELLO_FIXED_SIZE, decoded));
  CHECK(decoded.announced.lastFault == VmFault::None && decoded.announced.vmFailing);
  // A model code outside the contract is not a known model.
  body[HELLO_MODEL_OFFSET] = 0;
  CHECK(decodeHello(body, HELLO_FIXED_SIZE, decoded) && !decoded.announced.modelKnown);
}

J5_HOST_TEST(testEchoMessages) {
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  std::memset(body, 0xAA, sizeof(body));
  const EchoRequestMessage request{42, 16};
  CHECK(encodeEchoRequest(request, body) == 16);
  CHECK(readUint16(body + ECHO_NUMBER_OFFSET) == 42 && body[15] == 0 && body[16] == 0xAA);
  EchoRequestMessage decodedRequest{};
  CHECK(decodeEchoRequest(body, 16, decodedRequest));
  CHECK(decodedRequest.number == 42 && decodedRequest.size == 16);
  CHECK(decodeEchoRequest(body, ECHO_REPLY_FIELDS_SIZE, decodedRequest));
  CHECK(!decodeEchoRequest(body, ECHO_REPLY_FIELDS_SIZE - 1, decodedRequest));

  // The reply carries the quality of the request with the resolution of the body.
  const EchoReplyMessage reply{42, -87.6f, -3.3f, MAXIMUM_PAYLOAD_SIZE};
  CHECK(encodeEchoReply(reply, body) == MAXIMUM_PAYLOAD_SIZE);
  EchoReplyMessage decodedReply{};
  CHECK(decodeEchoReply(body, MAXIMUM_PAYLOAD_SIZE, decodedReply));
  CHECK(decodedReply.number == 42 && decodedReply.size == MAXIMUM_PAYLOAD_SIZE);
  CHECK(decodedReply.rssi == -88.0f && decodedReply.snr == -3.25f);
  CHECK(!decodeEchoReply(body, ECHO_REPLY_FIELDS_SIZE - 1, decodedReply));
}

J5_HOST_TEST(testTestMessage) {
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  CHECK(encodeTest(TestMessage{3, 299, 300, 50, MAXIMUM_PAYLOAD_SIZE}, body) ==
        MAXIMUM_PAYLOAD_SIZE);
  CHECK(readUint16(body + TEST_RUN_OFFSET) == 3 && readUint16(body + TEST_INDEX_OFFSET) == 299);
  CHECK(readUint16(body + TEST_COUNT_OFFSET) == 300);
  CHECK(readUint16(body + TEST_INTERVAL_OFFSET) == 50 && body[MAXIMUM_PAYLOAD_SIZE - 1] == 0);
  TestMessage decoded{};
  CHECK(decodeTest(body, MAXIMUM_PAYLOAD_SIZE, decoded));
  CHECK(decoded.run == 3 && decoded.index == 299 && decoded.count == 300);
  CHECK(decoded.interval == 50 && decoded.size == MAXIMUM_PAYLOAD_SIZE);
  CHECK(!decodeTest(body, TEST_FIELDS_SIZE - 1, decoded));
  // An index outside the count, and a run of no frames.
  encodeTest(TestMessage{1, 5, 5, 0, TEST_FIELDS_SIZE}, body);
  CHECK(!decodeTest(body, TEST_FIELDS_SIZE, decoded));
  encodeTest(TestMessage{1, 0, 0, 0, TEST_FIELDS_SIZE}, body);
  CHECK(!decodeTest(body, TEST_FIELDS_SIZE, decoded));
}

static bool decodeRawFragment(uint32_t version, uint8_t index, uint8_t count, uint8_t size,
                              uint8_t remaining, size_t dataLength) {
  uint8_t body[MAXIMUM_PAYLOAD_SIZE + 8] = {};
  writeUint32(body + FRAGMENT_VERSION_OFFSET, version);
  body[FRAGMENT_INDEX_OFFSET] = index;
  body[FRAGMENT_COUNT_OFFSET] = count;
  body[FRAGMENT_SIZE_OFFSET] = size;
  body[FRAGMENT_REMAINING_OFFSET] = remaining;
  FragmentMessage fragment{};
  return decodeFragment(body, FRAGMENT_HEADER_SIZE + dataLength, fragment);
}

J5_HOST_TEST(testFragmentMessages) {
  uint8_t image[200];
  for (size_t index = 0; index < sizeof(image); ++index) {
    image[index] = static_cast<uint8_t>(index);
  }
  // 200 bytes in fragments of 64: 64, 64, 64 and 8.
  CHECK(fragmentCountFor(sizeof(image), 64) == 4);
  const FragmentMessage last{77, 3, 4, 64, 0, image + 3 * 64, 8};
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  const size_t length = encodeFragment(last, body);
  CHECK(length == FRAGMENT_HEADER_SIZE + 8);
  CHECK(readUint32(body + FRAGMENT_VERSION_OFFSET) == 77 && body[FRAGMENT_INDEX_OFFSET] == 3);
  CHECK(body[FRAGMENT_COUNT_OFFSET] == 4 && body[FRAGMENT_SIZE_OFFSET] == 64);
  CHECK(body[FRAGMENT_REMAINING_OFFSET] == 0 && body[FRAGMENT_HEADER_SIZE] == 192);
  FragmentMessage decoded{};
  CHECK(decodeFragment(body, length, decoded));
  CHECK(decoded.version == 77 && decoded.index == 3 && decoded.count == 4 && decoded.size == 64);
  CHECK(decoded.remaining == 0 && decoded.dataLength == 8);
  CHECK(decoded.data == body + FRAGMENT_HEADER_SIZE && decoded.data[0] == 192);
  // A body with nothing after the header.
  CHECK(!decodeFragment(body, FRAGMENT_HEADER_SIZE, decoded));
  // The frame of a full fragment of the largest size is the largest frame.
  CHECK(fragmentFrameLength(MAXIMUM_FRAGMENT_SIZE) == MAXIMUM_FRAME_SIZE);

  // The size goes from MINIMUM_FRAGMENT_SIZE to MAXIMUM_FRAGMENT_SIZE, and the version starts at
  // MINIMUM_IMAGE_VERSION.
  const uint8_t smallest = MINIMUM_FRAGMENT_SIZE;
  const uint8_t largest = MAXIMUM_FRAGMENT_SIZE;
  CHECK(decodeRawFragment(1, 0, 3, smallest, 2, smallest));
  CHECK(!decodeRawFragment(1, 0, 3, smallest - 1, 2, smallest - 1));
  CHECK(decodeRawFragment(1, 0, 1, largest, 0, MINIMUM_IMAGE_SIZE));
  CHECK(!decodeRawFragment(1, 0, 1, largest + 1, 0, MINIMUM_IMAGE_SIZE));
  CHECK(!decodeRawFragment(MINIMUM_IMAGE_VERSION - 1, 0, 3, smallest, 2, smallest));
  // Index and remaining below count.
  CHECK(!decodeRawFragment(1, 3, 3, smallest, 0, 10));
  CHECK(!decodeRawFragment(1, 0, 3, smallest, 3, smallest));
  // count x size reaches MINIMUM_IMAGE_SIZE; (count - 1) x size stays below MAXIMUM_IMAGE_SIZE.
  const uint8_t shortCount = (MINIMUM_IMAGE_SIZE - 1) / smallest;
  CHECK(!decodeRawFragment(1, 0, shortCount, smallest, 0, smallest));
  CHECK(decodeRawFragment(1, 0, shortCount + 1, smallest, 0, smallest));
  const uint8_t longCount = MAXIMUM_FRAGMENT_COUNT;
  CHECK(decodeRawFragment(1, longCount - 1, longCount, smallest, 0,
                          MAXIMUM_IMAGE_SIZE - (longCount - 1) * smallest));
  CHECK(!decodeRawFragment(1, longCount, longCount + 1, smallest, 0, 1));
  // Data: exactly size bytes but in the last fragment, which holds 1 to size.
  CHECK(!decodeRawFragment(1, 0, 3, smallest, 0, smallest - 1));
  CHECK(!decodeRawFragment(1, 0, 3, smallest, 0, smallest + 1));
  CHECK(decodeRawFragment(1, 2, 3, smallest, 0, 1));
  CHECK(!decodeRawFragment(1, 2, 3, smallest, 0, 0));
  CHECK(!decodeRawFragment(1, 2, 3, smallest, 0, smallest + 1));
  // The last fragment does not carry the image past MAXIMUM_IMAGE_SIZE.
  const uint8_t largestCount = fragmentCountFor(MAXIMUM_IMAGE_SIZE, largest);
  const size_t largestLast = MAXIMUM_IMAGE_SIZE - (largestCount - 1U) * largest;
  CHECK(decodeRawFragment(1, largestCount - 1, largestCount, largest, 0, largestLast));
  CHECK(!decodeRawFragment(1, largestCount - 1, largestCount, largest, 0, largestLast + 1));
  // A last fragment that leaves the image below MINIMUM_IMAGE_SIZE is a valid body.
  CHECK(decodeRawFragment(1, 0, 1, largest, 0, MINIMUM_IMAGE_SIZE - 1));
}

J5_HOST_TEST(testReportMessages) {
  ReportMessage report{};
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
  const size_t length = encodeReport(report, body);
  CHECK(length == REPORT_FIXED_SIZE + 2);
  CHECK(readUint32(body + REPORT_VERSION_OFFSET) == 0x01020304);
  CHECK(body[REPORT_SIZE_OFFSET] == 32 && body[REPORT_COUNT_OFFSET] == 10);
  CHECK(body[REPORT_FIXED_SIZE] == 0x01 && body[REPORT_FIXED_SIZE + 1] == 0x03);
  CHECK(reportFrameLength(MAXIMUM_FRAGMENT_COUNT) == FRAME_OVERHEAD + MAXIMUM_REPORT_SIZE);

  // The length must match the count, which goes from 1 to MAXIMUM_FRAGMENT_COUNT.
  ReportMessage decoded{};
  CHECK(decodeReport(body, length, decoded));
  CHECK(decoded.count == 10 && isFragmentMarked(decoded, 9) && !isFragmentMarked(decoded, 1));
  CHECK(!decodeReport(body, length - 1, decoded));
  CHECK(!decodeReport(body, length + 1, decoded));
  body[REPORT_COUNT_OFFSET] = 0;
  CHECK(!decodeReport(body, REPORT_FIXED_SIZE, decoded));
  body[REPORT_COUNT_OFFSET] = MAXIMUM_FRAGMENT_COUNT;
  CHECK(decodeReport(body, REPORT_FIXED_SIZE + MAXIMUM_REPORT_BITMAP_SIZE, decoded));
  body[REPORT_COUNT_OFFSET] = MAXIMUM_FRAGMENT_COUNT + 1;
  CHECK(!decodeReport(body, REPORT_FIXED_SIZE + reportBitmapSize(MAXIMUM_FRAGMENT_COUNT + 1),
                      decoded));
  // The size goes from MINIMUM_FRAGMENT_SIZE to MAXIMUM_FRAGMENT_SIZE, and the version starts at
  // MINIMUM_IMAGE_VERSION.
  body[REPORT_COUNT_OFFSET] = 8;
  const size_t oneByte = REPORT_FIXED_SIZE + 1;
  CHECK(decodeReport(body, oneByte, decoded));
  body[REPORT_SIZE_OFFSET] = MINIMUM_FRAGMENT_SIZE - 1;
  CHECK(!decodeReport(body, oneByte, decoded));
  body[REPORT_SIZE_OFFSET] = MAXIMUM_FRAGMENT_SIZE + 1;
  CHECK(!decodeReport(body, oneByte, decoded));
  body[REPORT_SIZE_OFFSET] = MAXIMUM_FRAGMENT_SIZE;
  CHECK(decodeReport(body, oneByte, decoded));
  writeUint32(body + REPORT_VERSION_OFFSET, MINIMUM_IMAGE_VERSION - 1);
  CHECK(!decodeReport(body, oneByte, decoded));
}

J5_HOST_TEST(testMessageBodyDecoding) {
  uint8_t body[MAXIMUM_PAYLOAD_SIZE] = {};
  MessageBody decoded{};
  // A code outside the contract, before any body rule.
  CHECK(decodeMessageBody(0x7F, body, 0, decoded) == BodyCheck::UnknownType);

  // Each type goes to its own codec, which fills its member.
  const size_t helloLength = encodeHello(HelloMessage{}, body);
  CHECK(decodeMessageBody(static_cast<uint8_t>(MessageType::Hello), body, helloLength, decoded) ==
        BodyCheck::Valid);
  CHECK(decoded.type == MessageType::Hello && decoded.hello.neighborCount == 0);
  CHECK(decodeMessageBody(static_cast<uint8_t>(MessageType::Hello), body, helloLength + 1,
                          decoded) == BodyCheck::Invalid);

  encodeEchoRequest(EchoRequestMessage{7, 20}, body);
  CHECK(decodeMessageBody(static_cast<uint8_t>(MessageType::EchoRequest), body, 20, decoded) ==
        BodyCheck::Valid);
  CHECK(decoded.type == MessageType::EchoRequest && decoded.echoRequest.number == 7);
  CHECK(decoded.echoRequest.size == 20);
  CHECK(decodeMessageBody(static_cast<uint8_t>(MessageType::EchoReply), body,
                          ECHO_REPLY_FIELDS_SIZE - 1, decoded) == BodyCheck::Invalid);

  encodeTest(TestMessage{4, 1, 2, 0, TEST_FIELDS_SIZE}, body);
  CHECK(decodeMessageBody(static_cast<uint8_t>(MessageType::Test), body, TEST_FIELDS_SIZE,
                          decoded) == BodyCheck::Valid);
  CHECK(decoded.type == MessageType::Test && decoded.test.run == 4 && decoded.test.index == 1);

  ReportMessage report{};
  report.version = 3;
  report.size = MINIMUM_FRAGMENT_SIZE;
  report.count = 3;
  markFragment(report, 2);
  const size_t reportLength = encodeReport(report, body);
  CHECK(decodeMessageBody(static_cast<uint8_t>(MessageType::Report), body, reportLength, decoded) ==
        BodyCheck::Valid);
  CHECK(decoded.type == MessageType::Report && decoded.report.version == 3);
  CHECK(isFragmentMarked(decoded.report, 2) && !isFragmentMarked(decoded.report, 1));
  // The same bytes are not a valid FRAGMENT.
  CHECK(decodeMessageBody(static_cast<uint8_t>(MessageType::Fragment), body, reportLength,
                          decoded) == BodyCheck::Invalid);
}
