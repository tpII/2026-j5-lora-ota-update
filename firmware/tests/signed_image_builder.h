#ifndef J5_SIGNED_IMAGE_BUILDER_H
#define J5_SIGNED_IMAGE_BUILDER_H

#include <stdint.h>

#include <string>

// An image of the program, given as hexadecimal digits, signed with the development key of the
// operator (firmware/protocol/default_operator_key.pem), which the firmware accepts by default.
// Returns the image as load_image takes it.
std::string buildSignedImage(uint32_t version, const char *programHexadecimal);

#endif
