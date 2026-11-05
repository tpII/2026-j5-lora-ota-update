/**
 * Image signed with OpenSSL and the default operator key (keys/default_operator_key.pem), shared
 * by the tests of the panel and of the firmware so both are checked against the same bytes.
 * Ed25519 is deterministic: signing the same message with the same key gives the same signature.
 */

/** LOAD R1, 5; LOAD R2, 3; ADDR R1, R2; PRINT R1; SUBI R1, 10; MULR R1, R2; PRINT R1; HALT. */
export const TEST_VECTOR_PROGRAM = "020105000000020203000000110102010112010a000000150102010100";

/** 2025-11-05 00:00:00 UTC, in Unix seconds. */
export const TEST_VECTOR_VERSION = 1762300800;

export const TEST_VECTOR_HEADER = "4a350080930a691d00";

/** Header followed by the SHA-256 of the program. */
export const TEST_VECTOR_SIGNED_MESSAGE =
  "4a350080930a691d006684b5a991d2d40592223c279942ecb99a527c935e7721e1c2fcf0289211505f";

export const TEST_VECTOR_SIGNATURE =
  "0da5d66cf668f27563cc61734a4edcb606340c76cc3cd4f8c18d3d986b5fb7642a12459c81095e0b99da5efee4b5d5d009f251901d8df4c8597c01e195e8d008";

export const TEST_VECTOR_IMAGE =
  "4a350080930a691d00020105000000020203000000110102010112010a0000001501020101000da5d66cf668f27563cc61734a4edcb606340c76cc3cd4f8c18d3d986b5fb7642a12459c81095e0b99da5efee4b5d5d009f251901d8df4c8597c01e195e8d008";
