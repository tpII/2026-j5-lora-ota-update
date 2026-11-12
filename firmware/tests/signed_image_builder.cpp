#include "signed_image_builder.h"

#include <sodium.h>
#include <string.h>

#include "encoding/byte_order.h"
#include "encoding/hex_codec.h"
#include "generated_test_vectors.h"
#include "host_test_harness.h"

using namespace firmware;

std::string buildSignedImage(uint32_t version, const char *programHexadecimal) {
  uint8_t seed[crypto_sign_ed25519_SEEDBYTES];
  size_t seedLength = 0;
  CHECK(decodeHexBytes(DEFAULT_OPERATOR_KEY_SEED, seed, sizeof(seed), seedLength));
  uint8_t publicKey[crypto_sign_ed25519_PUBLICKEYBYTES];
  uint8_t secretKey[crypto_sign_ed25519_SECRETKEYBYTES];
  crypto_sign_ed25519_seed_keypair(publicKey, secretKey, seed);

  uint8_t image[MAXIMUM_IMAGE_SIZE] = {};
  size_t programLength = 0;
  CHECK(decodeHexBytes(programHexadecimal, image + IMAGE_HEADER_SIZE, PROGRAM_CAPACITY,
                       programLength));
  memcpy(image + IMAGE_MAGIC_OFFSET, IMAGE_MAGIC, sizeof(IMAGE_MAGIC));
  image[IMAGE_FLAGS_OFFSET] = IMAGE_FLAGS;
  writeUint32(image + IMAGE_VERSION_OFFSET, version);
  writeUint16(image + IMAGE_PROGRAM_LENGTH_OFFSET, static_cast<uint16_t>(programLength));
  uint8_t message[IMAGE_SIGNED_MESSAGE_SIZE];
  memcpy(message, image, IMAGE_HEADER_SIZE);
  crypto_hash_sha256(message + IMAGE_HEADER_SIZE, image + IMAGE_HEADER_SIZE, programLength);
  crypto_sign_ed25519_detached(image + IMAGE_HEADER_SIZE + programLength, nullptr, message,
                               sizeof(message), secretKey);

  const size_t imageLength = IMAGE_HEADER_SIZE + programLength + IMAGE_SIGNATURE_SIZE;
  std::string text(2 * imageLength, '\0');
  encodeHexBytes(image, imageLength, &text[0]);
  return text;
}
