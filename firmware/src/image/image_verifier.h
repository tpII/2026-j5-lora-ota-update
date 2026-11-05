#ifndef J5_IMAGE_VERIFIER_H
#define J5_IMAGE_VERIFIER_H

#include <stddef.h>
#include <stdint.h>

#include "image_format.h"

namespace firmware {

// Outcome of the verification, with the reason names of the console ("format", "signature" and
// "program").
enum class ImageCheck : uint8_t { Valid, Format, Signature, Program };

const char *imageCheckName(ImageCheck check);

// Checks a whole image against docs/protocol/image.md: length, header fields, the Ed25519 signature
// of the operator over the header and the SHA-256 of the program, and the VM validation of the
// program. Uses libsodium, which the ESP32 core ships precompiled.
class ImageVerifier {
public:
  // Initializes libsodium and decodes the operator public key, given as 64 hexadecimal digits.
  // Returns false when either fails; every image then fails with Signature.
  bool begin(const char *publicKeyHex);
  bool isKeyValid() const { return keyValid_; }

  // Checks the conditions in the order of the contract and stops at the first that fails. The
  // detail buffer receives a short English explanation that starts with the reason name. The
  // header is filled whenever the data holds one.
  ImageCheck verify(const uint8_t *image, size_t length, ImageHeader &header, char *detail,
                    size_t detailCapacity) const;
  // The two halves of verify, for a caller that checks something between them, as load_image
  // checks the version. checkFormat covers the length and the header fields and returns Valid or
  // Format; checkSignatureAndProgram takes an image that passed it and returns Valid, Signature
  // or Program.
  ImageCheck checkFormat(const uint8_t *image, size_t length, ImageHeader &header, char *detail,
                         size_t detailCapacity) const;
  ImageCheck checkSignatureAndProgram(const uint8_t *image, const ImageHeader &header, char *detail,
                                      size_t detailCapacity) const;

private:
  uint8_t publicKey_[OPERATOR_PUBLIC_KEY_SIZE] = {};
  bool keyValid_ = false;
};

} // namespace firmware

#endif
