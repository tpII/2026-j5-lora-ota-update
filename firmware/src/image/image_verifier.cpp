#include "image_verifier.h"

#include <sodium.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "../encoding/byte_order.h"
#include "../encoding/hex_codec.h"

namespace firmware {

static_assert(crypto_hash_sha256_BYTES == IMAGE_PROGRAM_DIGEST_SIZE,
              "the operator signs the SHA-256 of the program");

bool ImageRejection::reject(ImageRejectionReason reason, const char *format, ...) {
  reason_ = reason;
  if (detailCapacity_ == 0) {
    return false;
  }
  const int written = snprintf(detail_, detailCapacity_, "%s: ", imageRejectionReasonName(reason));
  if (written > 0 && static_cast<size_t>(written) < detailCapacity_) {
    va_list arguments;
    va_start(arguments, format);
    vsnprintf(detail_ + written, detailCapacity_ - written, format, arguments);
    va_end(arguments);
  }
  return false;
}

static bool rejectFormat(ImageRejection &rejection, ImageFormatDefect defect) {
  return rejection.reject(ImageRejectionReason::Format, "%s", imageFormatDefectDetail(defect));
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

bool ImageVerifier::verify(const uint8_t *image, size_t length, ImageHeader &header,
                           ValidProgram &program, ImageRejection &rejection) const {
  return checkFormat(image, length, header, rejection) &&
         checkSignatureAndProgram(image, header, program, rejection);
}

bool ImageVerifier::checkFormat(const uint8_t *image, size_t length, ImageHeader &header,
                                ImageRejection &rejection) const {
  header = ImageHeader{};
  if (length < IMAGE_HEADER_SIZE) {
    return rejectFormat(rejection, ImageFormatDefect::ShorterThanHeader);
  }
  header.flags = image[IMAGE_FLAGS_OFFSET];
  header.version = readUint32(image + IMAGE_VERSION_OFFSET);
  header.programLength = readUint16(image + IMAGE_PROGRAM_LENGTH_OFFSET);

  if (length != IMAGE_HEADER_SIZE + header.programLength + IMAGE_SIGNATURE_SIZE) {
    return rejectFormat(rejection, ImageFormatDefect::LengthMismatch);
  }
  if (memcmp(image + IMAGE_MAGIC_OFFSET, IMAGE_MAGIC, sizeof(IMAGE_MAGIC)) != 0) {
    return rejectFormat(rejection, ImageFormatDefect::BadMagic);
  }
  if (header.flags != IMAGE_FLAGS) {
    return rejectFormat(rejection, ImageFormatDefect::BadFlags);
  }
  if (header.version < MINIMUM_IMAGE_VERSION) {
    return rejectFormat(rejection, ImageFormatDefect::FactoryVersion);
  }
  if (header.programLength < MINIMUM_PROGRAM_SIZE || header.programLength > MAXIMUM_PROGRAM_SIZE) {
    return rejectFormat(rejection, ImageFormatDefect::ProgramLengthOutOfRange);
  }
  return true;
}

bool ImageVerifier::checkSignatureAndProgram(const uint8_t *image, const ImageHeader &header,
                                             ValidProgram &program,
                                             ImageRejection &rejection) const {
  if (!keyValid_) {
    return rejection.reject(ImageRejectionReason::Signature, "operator key not valid");
  }
  // The signed message is the header followed by the SHA-256 of the program.
  const uint8_t *code = image + IMAGE_HEADER_SIZE;
  uint8_t message[IMAGE_SIGNED_MESSAGE_SIZE];
  memcpy(message, image, IMAGE_HEADER_SIZE);
  crypto_hash_sha256(message + IMAGE_HEADER_SIZE, code, header.programLength);
  const uint8_t *signature = code + header.programLength;
  if (crypto_sign_ed25519_verify_detached(signature, message, sizeof(message), publicKey_) != 0) {
    return rejection.reject(ImageRejectionReason::Signature, "not signed by the operator");
  }

  ProgramDefect defect{};
  if (!validateProgram(code, header.programLength, program, defect)) {
    // The fault with the names of vm_fault, as the program of the image would raise it.
    return rejection.reject(ImageRejectionReason::Program, "%s at %u", vmFaultName(defect.fault),
                            static_cast<unsigned>(defect.address));
  }
  return true;
}

} // namespace firmware
