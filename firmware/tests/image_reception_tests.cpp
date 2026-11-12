// Host tests of the reception of an image: the bytes received, the bounds of the length, the
// report and the deadlines.

#include <cstring>

#include "configuration.h"
#include "encoding/hex_codec.h"
#include "generated_test_vectors.h"
#include "host_test_harness.h"
#include "image/image_verifier.h"
#include "messages/fragment_message.h"
#include "messages/report_message.h"
#include "transfer/image_reception.h"

using namespace firmware;

// Encodes a fragment of the image and decodes it again, as a receiver would.
static bool makeFragment(const uint8_t *image, size_t imageLength, uint32_t version, uint8_t size,
                         uint8_t index, uint8_t remaining, uint8_t *body, FragmentMessage &fields) {
  FragmentMessage source{};
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

J5_HOST_TEST(testReceptionCoverage) {
  // The image of the test vector, 102 bytes: in fragments of 32 bytes, 32, 32, 32 and 6.
  uint8_t image[MAXIMUM_IMAGE_SIZE];
  size_t imageLength = 0;
  CHECK(decodeHexBytes(SIGNED_IMAGE_VECTOR_IMAGE, image, sizeof(image), imageLength));
  const uint32_t version = SIGNED_IMAGE_VECTOR_VERSION;
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  FragmentMessage fields{};

  ImageReception reception;
  reception.reset();
  CHECK(!reception.isActive());
  CHECK(makeFragment(image, imageLength, version, 32, 2, 1, body, fields));
  FragmentReceipt receipt = reception.offer(0x3A7F, fields, 1000, 20);
  CHECK(receipt.accepted && receipt.contributed && reception.fragmentCount() == 1);
  CHECK(reception.isActive() && reception.version() == version && !reception.isLengthKnown());
  // While the length is unknown, the missing bytes count up to 4 x 32.
  CHECK(reception.missingByteCount() == 128 - 32);

  // Out of order, and a repeated fragment adds nothing.
  CHECK(makeFragment(image, imageLength, version, 32, 0, 0, body, fields));
  receipt = reception.offer(0x3A7F, fields, 1010, 20);
  CHECK(receipt.accepted && receipt.contributed && reception.fragmentCount() == 2);
  receipt = reception.offer(0x3A7F, fields, 1020, 20);
  CHECK(receipt.accepted && !receipt.contributed);

  // The report marks fragment 1 and the last one, whose length is still unknown.
  ReportMessage report{};
  reception.buildReport(report);
  CHECK(report.version == version && report.size == 32 && report.count == 4);
  CHECK(report.missing[0] == 0x0A);

  // The last fragment gives the exact length.
  CHECK(makeFragment(image, imageLength, version, 32, 3, 0, body, fields));
  reception.offer(0x3A7F, fields, 1030, 20);
  CHECK(reception.isLengthKnown() && reception.imageLength() == imageLength);
  CHECK(reception.missingByteCount() == 32 && !reception.isComplete());
  reception.buildReport(report);
  CHECK(report.missing[0] == 0x02);

  // A fragment of another size fills the gap: bytes 0 to 63 in fragments of 64.
  CHECK(makeFragment(image, imageLength, version, 64, 0, 0, body, fields));
  receipt = reception.offer(0x00F4, fields, 1040, 30);
  CHECK(receipt.accepted && receipt.contributed && reception.isComplete());
  CHECK(std::memcmp(reception.image(), image, imageLength) == 0);
  CHECK(reception.missingByteCount() == 0 && reception.fragmentCount() == 5);
  CHECK(reception.lastSource() == 0x00F4);
  ImageVerifier verifier;
  CHECK(verifier.begin(J5_OPERATOR_PUBLIC_KEY));
  ImageHeader header{};
  ValidProgram valid;
  ImageRejection rejection;
  CHECK(verifier.verify(reception.image(), reception.imageLength(), header, valid, rejection));

  // Mixed sizes from the start: the last fragment of 64 and the two first of 32.
  reception.reset();
  CHECK(makeFragment(image, imageLength, version, 64, 1, 0, body, fields));
  reception.offer(0x3A7F, fields, 0, 30);
  CHECK(reception.isLengthKnown() && reception.missingByteCount() == 64);
  CHECK(makeFragment(image, imageLength, version, 32, 0, 1, body, fields));
  reception.offer(0x3A7F, fields, 0, 20);
  CHECK(makeFragment(image, imageLength, version, 32, 1, 0, body, fields));
  reception.offer(0x3A7F, fields, 0, 20);
  CHECK(reception.isComplete());

  // A fragment that contradicts the known length restarts the reception with it.
  reception.reset();
  CHECK(makeFragment(image, imageLength, version, 32, 3, 0, body, fields));
  reception.offer(0x3A7F, fields, 0, 20);
  CHECK(makeFragment(image, imageLength, version, 32, 0, 0, body, fields));
  reception.offer(0x3A7F, fields, 0, 20);
  uint8_t longer[MAXIMUM_IMAGE_SIZE];
  memcpy(longer, image, imageLength);
  CHECK(makeFragment(longer, imageLength + 10, version, 32, 3, 0, body, fields));
  receipt = reception.offer(0x3A7F, fields, 0, 20);
  CHECK(receipt.accepted && reception.fragmentCount() == 1);
  CHECK(reception.imageLength() == imageLength + 10 && reception.missingByteCount() == 96);
  // A non-last fragment of 64 bytes leaves the length between 65 and 128: no contradiction.
  CHECK(makeFragment(longer, imageLength + 10, version, 64, 0, 1, body, fields));
  receipt = reception.offer(0x3A7F, fields, 0, 20);
  CHECK(receipt.accepted && reception.fragmentCount() == 2);

  // A newer version replaces the reception; an older one is ignored.
  CHECK(makeFragment(image, imageLength, version + 1, 32, 0, 3, body, fields));
  receipt = reception.offer(0x3A7F, fields, 0, 20);
  CHECK(reception.fragmentCount() == 1 && reception.version() == version + 1);
  CHECK(makeFragment(image, imageLength, version, 32, 1, 2, body, fields));
  receipt = reception.offer(0x3A7F, fields, 0, 20);
  CHECK(!receipt.accepted && reception.version() == version + 1);

  // A last fragment that ends past the largest image is an invalid body; offered all the same,
  // it fits no image and leaves the reception untouched.
  reception.reset();
  uint8_t filler[MAXIMUM_PAYLOAD_SIZE] = {};
  fields = FragmentMessage{};
  fields.version = 9;
  fields.size = MAXIMUM_FRAGMENT_SIZE;
  fields.count = fragmentCountFor(MAXIMUM_IMAGE_SIZE, MAXIMUM_FRAGMENT_SIZE);
  fields.index = fields.count - 1;
  fields.data = filler;
  fields.dataLength = MAXIMUM_FRAGMENT_SIZE;
  CHECK(static_cast<size_t>(fields.count) * fields.size > MAXIMUM_IMAGE_SIZE);
  receipt = reception.offer(0x3A7F, fields, 0, 20);
  CHECK(!receipt.accepted && !reception.isActive());

  // A last fragment that leaves the image below MINIMUM_IMAGE_SIZE belongs to the reception: the
  // bytes complete and the verification rejects the image for format.
  const size_t shortLength = MINIMUM_IMAGE_SIZE - 1;
  reception.reset();
  CHECK(makeFragment(image, shortLength, version, MAXIMUM_FRAGMENT_SIZE, 0, 0, body, fields));
  receipt = reception.offer(0x3A7F, fields, 0, 20);
  CHECK(receipt.accepted && reception.fragmentCount() == 1 && reception.isComplete());
  CHECK(reception.imageLength() == shortLength);
  CHECK(!verifier.verify(reception.image(), reception.imageLength(), header, valid, rejection));
  CHECK(rejection.reason() == ImageRejectionReason::Format);
  // In a reception in progress it contradicts the known length and restarts it.
  reception.reset();
  CHECK(makeFragment(image, imageLength, version, 32, 0, 3, body, fields));
  reception.offer(0x3A7F, fields, 0, 20);
  CHECK(makeFragment(image, shortLength, version, MINIMUM_IMAGE_SIZE / 2 + 1, 1, 0, body, fields));
  receipt = reception.offer(0x3A7F, fields, 0, 20);
  CHECK(receipt.accepted && reception.isLengthKnown());
  CHECK(reception.imageLength() == shortLength && reception.fragmentCount() == 1);
  // Before its last fragment arrives, the length of an image is unknown even when count x size
  // is MINIMUM_IMAGE_SIZE.
  reception.reset();
  CHECK(
      makeFragment(image, MINIMUM_IMAGE_SIZE, version, MINIMUM_IMAGE_SIZE / 2, 0, 1, body, fields));
  CHECK(static_cast<size_t>(fields.count) * fields.size == MINIMUM_IMAGE_SIZE);
  reception.offer(0x3A7F, fields, 0, 20);
  CHECK(!reception.isLengthKnown());
}

J5_HOST_TEST(testReceptionDeadlines) {
  uint8_t image[MAXIMUM_IMAGE_SIZE];
  size_t imageLength = 0;
  CHECK(decodeHexBytes(SIGNED_IMAGE_VECTOR_IMAGE, image, sizeof(image), imageLength));
  uint8_t body[MAXIMUM_PAYLOAD_SIZE];
  FragmentMessage fields{};
  ImageReception reception;
  reception.reset();

  // Three fragments still to come, 20 ms each: the burst ends 60 ms plus TRANSFER_MARGIN_MS later.
  CHECK(makeFragment(image, imageLength, 1, 32, 0, 3, body, fields));
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
  CHECK(makeFragment(image, imageLength, 1, 32, 1, 1, body, fields));
  reception.offer(0x3A7F, fields, 2600, 20);
  CHECK(reception.isBurstInProgress(2600) && !reception.isReportDue(3000));
  CHECK(makeFragment(image, imageLength, 1, 32, 3, 0, body, fields));
  reception.offer(0x3A7F, fields, 2620, 20);
  CHECK(!reception.isBurstInProgress(2620) && reception.isReportDue(2620));
  ReportMessage report{};
  reception.buildReport(report);
  CHECK(report.missing[0] == 0x04);
  // Complete: no report is due any more.
  CHECK(makeFragment(image, imageLength, 1, 32, 2, 0, body, fields));
  reception.offer(0x3A7F, fields, 2640, 20);
  CHECK(reception.isComplete() && !reception.isReportDue(2640));
  CHECK(!reception.isBurstInProgress(2640));
  // Across the wrap of millis(): the deadline falls past it.
  reception.reset();
  CHECK(makeFragment(image, imageLength, 1, 32, 0, 1, body, fields));
  const uint32_t beforeWrap = 0xFFFFFF00u;
  const uint32_t deadline = beforeWrap + 20 + TRANSFER_MARGIN_MS;
  CHECK(deadline < beforeWrap);
  reception.offer(0x3A7F, fields, beforeWrap, 20);
  CHECK(reception.isBurstInProgress(0xFFFFFFFFu) && !reception.isReportDue(0xFFFFFFFFu));
  CHECK(reception.isBurstInProgress(deadline - 1) && !reception.isReportDue(deadline - 1));
  CHECK(!reception.isBurstInProgress(deadline) && reception.isReportDue(deadline));
}
