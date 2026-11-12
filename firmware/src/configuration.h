#ifndef J5_CONFIGURATION_H
#define J5_CONFIGURATION_H

// Secrets are compiled into the firmware. To use other values, create firmware/build_opt.h (ignored
// by git) with one option per line, for example: -DJ5_NETWORK_KEY="\"another key\"". The boot
// event reports with J5_NETWORK_KEY_IS_DEFAULT and J5_OPERATOR_PUBLIC_KEY_IS_DEFAULT whether a
// build uses the default value.
#ifndef J5_NETWORK_KEY
#define J5_NETWORK_KEY "bichofeo"
#define J5_NETWORK_KEY_IS_DEFAULT 1
#else
#define J5_NETWORK_KEY_IS_DEFAULT 0
#endif

#ifndef J5_ACCESS_POINT_PASSWORD
#define J5_ACCESS_POINT_PASSWORD "bichofeo"
#endif

// Ed25519 public key of the operator, as 64 hexadecimal digits (docs/protocol/image.md). The
// default one belongs to the development key pair in firmware/protocol/default_operator_key.pem.
#ifndef J5_OPERATOR_PUBLIC_KEY
#define J5_OPERATOR_PUBLIC_KEY "9b82c16539e90d39d9f1a1f786f30c123d8292453b88bdd271c412230940b573"
#define J5_OPERATOR_PUBLIC_KEY_IS_DEFAULT 1
#else
#define J5_OPERATOR_PUBLIC_KEY_IS_DEFAULT 0
#endif

namespace firmware {

constexpr const char *FIRMWARE_VERSION = "0.2.0";

} // namespace firmware

#endif
