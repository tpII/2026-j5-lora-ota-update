#ifndef J5_IMAGE_VERIFIER_H
#define J5_IMAGE_VERIFIER_H

#include <stddef.h>
#include <stdint.h>

#include "../vm/virtual_machine.h"
#include "image_format.h"

namespace firmware {

// Why an image was rejected: the reason of the image_rejected event and, when the caller gives a
// buffer, the detail of the invalid_image error, a short English explanation that starts with the
// name of the reason, such as "format: bad magic number".
class ImageRejection {
public:
  ImageRejection() = default;
  ImageRejection(char *detail, size_t detailCapacity)
      : detail_(detail), detailCapacity_(detailCapacity) {}

  ImageRejectionReason reason() const { return reason_; }

  // Records the reason and writes "<reason>: <explanation>" to the buffer. Returns false, so that
  // a check can return what it returns.
  bool reject(ImageRejectionReason reason, const char *format, ...)
      __attribute__((format(printf, 3, 4)));

private:
  char *detail_ = nullptr;
  size_t detailCapacity_ = 0;
  ImageRejectionReason reason_ = ImageRejectionReason::Format;
};

// Checks a whole image against docs/protocol/image.md: length, header fields, the Ed25519 signature
// of the operator over the header and the SHA-256 of the program, and the VM validation of the
// program. Uses libsodium, which the ESP32 core ships precompiled.
class ImageVerifier {
public:
  // Initializes libsodium and decodes the operator public key, given as 64 hexadecimal digits.
  // Returns false when either fails; every image then fails with the reason signature.
  bool begin(const char *publicKeyHex);

  // Checks the conditions in the order of the contract and stops at the first that fails, which
  // the rejection describes. The header is filled whenever the data holds one, and when the image
  // is valid the program refers to the program inside the image, ready for the VM.
  bool verify(const uint8_t *image, size_t length, ImageHeader &header, ValidProgram &program,
              ImageRejection &rejection) const;
  // The two halves of verify, for a caller that checks something between them, as load_image
  // checks the version. checkFormat covers the length and the header fields, so it fails only
  // with the reason format; checkSignatureAndProgram takes an image that passed it.
  bool checkFormat(const uint8_t *image, size_t length, ImageHeader &header,
                   ImageRejection &rejection) const;
  bool checkSignatureAndProgram(const uint8_t *image, const ImageHeader &header,
                                ValidProgram &program, ImageRejection &rejection) const;

private:
  uint8_t publicKey_[OPERATOR_PUBLIC_KEY_SIZE] = {};
  bool keyValid_ = false;
};

} // namespace firmware

#endif
