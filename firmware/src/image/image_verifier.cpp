#include "image_verifier.h"

#include <sodium.h>
#include <stdio.h>
#include <string.h>

#include "../network/byte_order.h"

namespace firmware {

static void writeDetail(char *detail, size_t capacity, const char *text) {
  if (capacity > 0) {
    snprintf(detail, capacity, "%s", text);
  }
}

const char *imageCheckName(ImageCheck check) {
  switch (check) {
  case ImageCheck::Valid:
    return "valid";
  case ImageCheck::Format:
    return "format";
  case ImageCheck::Signature:
    return "signature";
  case ImageCheck::Program:
    return "program";
  }
  return "format";
}

bool ImageVerifier::begin(const char *publicKeyHex) {
  keyValid_ = false;
  if (sodium_init() < 0) {
    return false;
  }
  size_t length = 0;
  keyValid_ = decodeHexBytes(publicKeyHex, publicKey_, sizeof(publicKey_), length) &&
              length == OPERATOR_PUBLIC_KEY_SIZE;
  return keyValid_;
}

ImageCheck ImageVerifier::verify(const uint8_t *image, size_t length, ImageHeader &header,
                                 char *detail, size_t detailCapacity) const {
  const ImageCheck format = checkFormat(image, length, header, detail, detailCapacity);
  if (format != ImageCheck::Valid) {
    return format;
  }
  return checkSignatureAndProgram(image, header, detail, detailCapacity);
}

ImageCheck ImageVerifier::checkFormat(const uint8_t *image, size_t length, ImageHeader &header,
                                      char *detail, size_t detailCapacity) const {
  header = ImageHeader{};
  if (length < IMAGE_HEADER_SIZE) {
    writeDetail(detail, detailCapacity, "format: shorter than the header");
    return ImageCheck::Format;
  }
  header.flags = image[2];
  header.version = readUint32(image + 3);
  header.programLength = readUint16(image + 7);

  if (length != IMAGE_HEADER_SIZE + header.programLength + IMAGE_SIGNATURE_SIZE) {
    writeDetail(detail, detailCapacity, "format: length does not match the header");
    return ImageCheck::Format;
  }
  if (image[0] != IMAGE_MAGIC_FIRST || image[1] != IMAGE_MAGIC_SECOND) {
    writeDetail(detail, detailCapacity, "format: bad magic number");
    return ImageCheck::Format;
  }
  if (header.flags != 0) {
    writeDetail(detail, detailCapacity, "format: flags are not 0");
    return ImageCheck::Format;
  }
  if (header.version == 0) {
    writeDetail(detail, detailCapacity, "format: version 0");
    return ImageCheck::Format;
  }
  if (header.programLength == 0 || header.programLength > PROGRAM_CAPACITY) {
    writeDetail(detail, detailCapacity, "format: program length out of range");
    return ImageCheck::Format;
  }
  writeDetail(detail, detailCapacity, "");
  return ImageCheck::Valid;
}

ImageCheck ImageVerifier::checkSignatureAndProgram(const uint8_t *image, const ImageHeader &header,
                                                   char *detail, size_t detailCapacity) const {
  if (!keyValid_) {
    writeDetail(detail, detailCapacity, "signature: operator key not valid");
    return ImageCheck::Signature;
  }
  // The signed message is the header followed by the SHA-256 of the program.
  const uint8_t *program = image + IMAGE_HEADER_SIZE;
  uint8_t message[IMAGE_SIGNED_MESSAGE_SIZE];
  memcpy(message, image, IMAGE_HEADER_SIZE);
  crypto_hash_sha256(message + IMAGE_HEADER_SIZE, program, header.programLength);
  const uint8_t *signature = program + header.programLength;
  if (crypto_sign_ed25519_verify_detached(signature, message, sizeof(message), publicKey_) != 0) {
    writeDetail(detail, detailCapacity, "signature: not signed by the operator");
    return ImageCheck::Signature;
  }

  size_t errorOffset = 0;
  if (!validateProgram(program, header.programLength, errorOffset)) {
    if (detailCapacity > 0) {
      snprintf(detail, detailCapacity, "program: bad instruction at %u",
               static_cast<unsigned>(errorOffset));
    }
    return ImageCheck::Program;
  }
  writeDetail(detail, detailCapacity, "");
  return ImageCheck::Valid;
}

} // namespace firmware
