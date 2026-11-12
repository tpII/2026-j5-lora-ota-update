/**
 * The verification a node makes of an image it receives (docs/protocol/image.md), for the
 * simulated node and the tests: the panel itself only signs.
 */
import { decodeImage, type DecodedImage, type ImageDecoding } from "$lib/image/image-format.ts";
import { parseHex } from "$lib/utils/hex.ts";
import {
  DEFAULT_OPERATOR_PUBLIC_KEY,
  buildSignedMessage,
  isOperatorPublicKey,
} from "$lib/image/image-signing.ts";
import { IMAGE_HEADER_SIZE, IMAGE_SIGNATURE_SIZE } from "$lib/protocol/protocol-contract.ts";

/**
 * What verifyImage() finds: the image, or the reason of the `image_rejected` event a node would
 * emit, with the fault of a program the VM rejects.
 */
export type ImageVerification =
  | { readonly valid: true; readonly image: DecodedImage }
  | Exclude<ImageDecoding, { readonly valid: true }>
  | { readonly valid: false; readonly reason: "signature"; readonly message: string };

/**
 * Verifies an image as a node does: format, signature with `publicKey` (in the format of
 * J5_OPERATOR_PUBLIC_KEY) and program, in the order of the contract. A node built without J5_OPERATOR_PUBLIC_KEY verifies
 * with the default public key.
 */
export async function verifyImage(
  bytes: Uint8Array,
  publicKey: string = DEFAULT_OPERATOR_PUBLIC_KEY,
): Promise<ImageVerification> {
  const decoding = decodeImage(bytes);
  if (!decoding.valid && decoding.reason === "format") {
    return decoding;
  }
  const rawPublicKey = isOperatorPublicKey(publicKey) ? parseHex(publicKey) : null;
  if (rawPublicKey === null) {
    throw new RangeError("the operator public key must be 64 lowercase hexadecimal digits");
  }
  // The signature is checked before the program, in the order of the contract, so an image with a
  // bad program and a bad signature is rejected for its signature.
  const header = bytes.slice(0, IMAGE_HEADER_SIZE);
  const programEnd = bytes.length - IMAGE_SIGNATURE_SIZE;
  const program = bytes.slice(IMAGE_HEADER_SIZE, programEnd);
  const signature = bytes.slice(programEnd);
  const ed25519 = { name: "Ed25519" };
  const verifier = await crypto.subtle.importKey("raw", rawPublicKey, ed25519, false, ["verify"]);
  const message = await buildSignedMessage(header, program);
  if (!(await crypto.subtle.verify(ed25519, verifier, signature, message))) {
    return {
      valid: false,
      reason: "signature",
      message: "La firma no es válida con la clave pública del operador.",
    };
  }
  if (!decoding.valid) {
    return decoding;
  }
  return { valid: true, image: decoding.image };
}
