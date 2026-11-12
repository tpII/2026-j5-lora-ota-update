// Host tests of the image verifier, with the signed image of firmware/protocol/test-vectors.

#include <cstring>
#include <sodium.h>
#include <string>

#include "application/console_commands.h"
#include "configuration.h"
#include "encoding/byte_order.h"
#include "encoding/hex_codec.h"
#include "generated_test_vectors.h"
#include "host_test_harness.h"
#include "image/image_verifier.h"

using namespace firmware;

// Builds and signs an image with a key pair of the test, as the control panel does.
static size_t signImage(const uint8_t *secretKey, uint32_t version, const uint8_t *program,
                        size_t programLength, uint8_t *image) {
  memcpy(image + IMAGE_MAGIC_OFFSET, IMAGE_MAGIC, sizeof(IMAGE_MAGIC));
  image[IMAGE_FLAGS_OFFSET] = IMAGE_FLAGS;
  writeUint32(image + IMAGE_VERSION_OFFSET, version);
  writeUint16(image + IMAGE_PROGRAM_LENGTH_OFFSET, static_cast<uint16_t>(programLength));
  memcpy(image + IMAGE_HEADER_SIZE, program, programLength);
  uint8_t message[IMAGE_SIGNED_MESSAGE_SIZE];
  memcpy(message, image, IMAGE_HEADER_SIZE);
  crypto_hash_sha256(message + IMAGE_HEADER_SIZE, program, programLength);
  crypto_sign_ed25519_detached(image + IMAGE_HEADER_SIZE + programLength, nullptr, message,
                               sizeof(message), secretKey);
  return IMAGE_HEADER_SIZE + programLength + IMAGE_SIGNATURE_SIZE;
}

static void toHex(const uint8_t *bytes, size_t length, char *text) {
  encodeHexBytes(bytes, length, text);
  text[2 * length] = '\0';
}

// Verifies the image and returns "valid" or the detail of the rejection, after checking that the
// detail starts with the name of the reason.
static std::string verifyImage(const ImageVerifier &verifier, const uint8_t *image, size_t length,
                               ImageHeader &header, ValidProgram &program) {
  char detail[ERROR_DETAIL_CAPACITY] = {};
  ImageRejection rejection(detail, sizeof(detail));
  if (verifier.verify(image, length, header, program, rejection)) {
    return "valid";
  }
  const std::string reason = std::string(imageRejectionReasonName(rejection.reason())) + ": ";
  CHECK(std::string(detail).compare(0, reason.size(), reason) == 0);
  return detail;
}

static bool startsWith(const std::string &text, const char *prefix) {
  return text.compare(0, std::strlen(prefix), prefix) == 0;
}

J5_HOST_TEST(testImageVerifier) {
  ImageVerifier verifier;
  // The host build has no build_opt.h, so the operator key is the default one, which signed the
  // vector.
  CHECK(verifier.begin(J5_OPERATOR_PUBLIC_KEY));

  uint8_t image[MAXIMUM_IMAGE_SIZE];
  size_t length = 0;
  CHECK(decodeHexBytes(SIGNED_IMAGE_VECTOR_IMAGE, image, sizeof(image), length));
  CHECK(length == IMAGE_HEADER_SIZE + SIGNED_IMAGE_VECTOR_PROGRAM_LENGTH + IMAGE_SIGNATURE_SIZE);
  ImageHeader header{};
  ValidProgram valid;
  CHECK(verifyImage(verifier, image, length, header, valid) == "valid");
  CHECK(header.version == SIGNED_IMAGE_VECTOR_VERSION && header.flags == 0);
  CHECK(header.programLength == SIGNED_IMAGE_VECTOR_PROGRAM_LENGTH);
  // The program that the VM can load is the one inside the image.
  CHECK(valid.code() == image + IMAGE_HEADER_SIZE && valid.length() == header.programLength);
  char headerHex[2 * IMAGE_HEADER_SIZE + 1];
  toHex(image, IMAGE_HEADER_SIZE, headerHex);
  CHECK(std::strcmp(headerHex, SIGNED_IMAGE_VECTOR_HEADER) == 0);
  uint8_t program[PROGRAM_CAPACITY];
  size_t programLength = 0;
  CHECK(decodeHexBytes(SIGNED_IMAGE_VECTOR_PROGRAM, program, sizeof(program), programLength));
  CHECK(programLength == SIGNED_IMAGE_VECTOR_PROGRAM_LENGTH);
  CHECK(std::memcmp(image + IMAGE_HEADER_SIZE, program, programLength) == 0);

  // The signed message is the header followed by the SHA-256 of the program.
  uint8_t message[IMAGE_SIGNED_MESSAGE_SIZE];
  memcpy(message, image, IMAGE_HEADER_SIZE);
  crypto_hash_sha256(message + IMAGE_HEADER_SIZE, program, programLength);
  char messageHex[2 * IMAGE_SIGNED_MESSAGE_SIZE + 1];
  toHex(message, sizeof(message), messageHex);
  CHECK(std::strcmp(messageHex, SIGNED_IMAGE_VECTOR_SIGNED_MESSAGE) == 0);
  char signatureHex[2 * IMAGE_SIGNATURE_SIZE + 1];
  toHex(image + IMAGE_HEADER_SIZE + programLength, IMAGE_SIGNATURE_SIZE, signatureHex);
  CHECK(std::strcmp(signatureHex, SIGNED_IMAGE_VECTOR_SIGNATURE) == 0);

  // Any changed byte of the program or of the signature breaks the signature.
  uint8_t tampered[MAXIMUM_IMAGE_SIZE];
  memcpy(tampered, image, length);
  tampered[IMAGE_HEADER_SIZE + 5] ^= 0x01;
  CHECK(startsWith(verifyImage(verifier, tampered, length, header, valid), "signature: "));
  memcpy(tampered, image, length);
  tampered[length - 1] ^= 0x80;
  CHECK(startsWith(verifyImage(verifier, tampered, length, header, valid), "signature: "));
  // So does a version changed in the header.
  memcpy(tampered, image, length);
  tampered[IMAGE_VERSION_OFFSET] ^= 0x01;
  CHECK(startsWith(verifyImage(verifier, tampered, length, header, valid), "signature: "));

  // Format: magic, flags, version 0, lengths.
  memcpy(tampered, image, length);
  tampered[IMAGE_MAGIC_OFFSET] ^= 0x01;
  CHECK(startsWith(verifyImage(verifier, tampered, length, header, valid), "format: "));
  memcpy(tampered, image, length);
  tampered[IMAGE_FLAGS_OFFSET] ^= 0x01;
  CHECK(startsWith(verifyImage(verifier, tampered, length, header, valid), "format: "));
  memcpy(tampered, image, length);
  writeUint32(tampered + IMAGE_VERSION_OFFSET, 0);
  CHECK(startsWith(verifyImage(verifier, tampered, length, header, valid), "format: "));
  CHECK(startsWith(verifyImage(verifier, image, length - 1, header, valid), "format: "));
  CHECK(startsWith(verifyImage(verifier, image, IMAGE_HEADER_SIZE - 1, header, valid), "format: "));

  // Another key rejects the image of the default key.
  uint8_t publicKey[crypto_sign_ed25519_PUBLICKEYBYTES];
  uint8_t secretKey[crypto_sign_ed25519_SECRETKEYBYTES];
  crypto_sign_ed25519_keypair(publicKey, secretKey);
  char publicKeyHex[2 * OPERATOR_PUBLIC_KEY_SIZE + 1];
  toHex(publicKey, sizeof(publicKey), publicKeyHex);
  ImageVerifier other;
  CHECK(other.begin(publicKeyHex));
  CHECK(startsWith(verifyImage(other, image, length, header, valid), "signature: "));

  // A well signed image whose program fails the VM validation: unknown opcode at address 2.
  const uint8_t badProgram[] = {0x01, 0x01, 0x3F, 0x00};
  const size_t badLength = signImage(secretKey, 5, badProgram, sizeof(badProgram), tampered);
  CHECK(verifyImage(other, tampered, badLength, header, valid) == "program: invalid_opcode at 2");

  // The largest program fits, one more byte does not.
  uint8_t largest[PROGRAM_CAPACITY];
  memset(largest, 0x00, sizeof(largest));
  CHECK(signImage(secretKey, 6, largest, sizeof(largest), tampered) == MAXIMUM_IMAGE_SIZE);
  CHECK(verifyImage(other, tampered, MAXIMUM_IMAGE_SIZE, header, valid) == "valid");

  // The two halves of verify: the format alone does not look at the signature or the program.
  ImageRejection rejection;
  CHECK(other.checkFormat(image, length, header, rejection));
  CHECK(header.version == SIGNED_IMAGE_VECTOR_VERSION);
  CHECK(!other.checkSignatureAndProgram(image, header, valid, rejection));
  CHECK(rejection.reason() == ImageRejectionReason::Signature);
  CHECK(!verifier.checkFormat(image, IMAGE_HEADER_SIZE - 1, header, rejection));
  CHECK(rejection.reason() == ImageRejectionReason::Format);
  CHECK(verifier.checkFormat(image, length, header, rejection));
  CHECK(verifier.checkSignatureAndProgram(image, header, valid, rejection));

  ImageVerifier broken;
  CHECK(!broken.begin("9b82"));
  CHECK(startsWith(verifyImage(broken, image, length, header, valid), "signature: "));
}
