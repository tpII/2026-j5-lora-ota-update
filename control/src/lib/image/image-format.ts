/**
 * Image format of docs/protocol/image.md (ADR 0012): a 9-byte header with the magic number "J5",
 * the flags, the version and the program length, then the program and the Ed25519 signature of
 * the operator. Multi-byte fields are little-endian.
 */
import { PROGRAM_CAPACITY } from "$lib/vm/instruction-set.ts";
import { checkProgram, type VmFault } from "$lib/vm/virtual-machine.ts";

export const IMAGE_MAGIC: readonly number[] = [0x4a, 0x35];
export const IMAGE_FLAGS = 0;
export const IMAGE_HEADER_SIZE = 9;
export const IMAGE_SIGNATURE_SIZE = 64;
export const SHA256_DIGEST_SIZE = 32;
/** Header followed by the SHA-256 of the program: what the operator signs. */
export const SIGNED_MESSAGE_SIZE = IMAGE_HEADER_SIZE + SHA256_DIGEST_SIZE;

export const MINIMUM_PROGRAM_SIZE = 1;
export const MAXIMUM_PROGRAM_SIZE = PROGRAM_CAPACITY;
export const MINIMUM_IMAGE_SIZE = IMAGE_HEADER_SIZE + MINIMUM_PROGRAM_SIZE + IMAGE_SIGNATURE_SIZE;
export const MAXIMUM_IMAGE_SIZE = IMAGE_HEADER_SIZE + MAXIMUM_PROGRAM_SIZE + IMAGE_SIGNATURE_SIZE;

/** Version 0 is the factory program, which has no image. */
export const MINIMUM_IMAGE_VERSION = 1;
export const MAXIMUM_IMAGE_VERSION = 2 ** 32 - 1;

const VERSION_OFFSET = 3;
const LENGTH_OFFSET = 7;

export interface ImageHeader {
  readonly flags: number;
  readonly version: number;
  /** Program length in bytes. */
  readonly programLength: number;
}

/** An image whose structure is valid; the signature is not checked here. */
export interface DecodedImage extends ImageHeader {
  /** The 9 bytes of the header, as they are signed. */
  readonly header: Uint8Array<ArrayBuffer>;
  readonly program: Uint8Array<ArrayBuffer>;
  readonly signature: Uint8Array<ArrayBuffer>;
}

/**
 * Why a node rejects an image, with the names of the `image_rejected` event and of the `detail` of
 * `invalid_image`.
 */
export type ImageRejection = "format" | "signature" | "program";

export type ImageDecoding =
  | { readonly valid: true; readonly image: DecodedImage }
  | {
      readonly valid: false;
      readonly reason: "format" | "program";
      /** Description for the operator, in Spanish. */
      readonly message: string;
      /** With "program": the first fault the VM finds and its address. */
      readonly fault?: VmFault;
      readonly address?: number;
    };

export function isImageVersion(version: number): boolean {
  return (
    Number.isInteger(version) &&
    version >= MINIMUM_IMAGE_VERSION &&
    version <= MAXIMUM_IMAGE_VERSION
  );
}

/** The 9-byte header of an image with `version` and a program of `programLength` bytes. */
export function encodeImageHeader(version: number, programLength: number): Uint8Array<ArrayBuffer> {
  if (!isImageVersion(version)) {
    throw new RangeError(`image version out of range: ${version}`);
  }
  if (
    !Number.isInteger(programLength) ||
    programLength < MINIMUM_PROGRAM_SIZE ||
    programLength > MAXIMUM_PROGRAM_SIZE
  ) {
    throw new RangeError(`program length out of range: ${programLength}`);
  }
  const header = new Uint8Array(IMAGE_HEADER_SIZE);
  const view = new DataView(header.buffer);
  header.set(IMAGE_MAGIC, 0);
  header[2] = IMAGE_FLAGS;
  view.setUint32(VERSION_OFFSET, version, true);
  view.setUint16(LENGTH_OFFSET, programLength, true);
  return header;
}

/** Header, program and signature, in that order. */
export function assembleImage(
  header: Uint8Array,
  program: Uint8Array,
  signature: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (header.length !== IMAGE_HEADER_SIZE || signature.length !== IMAGE_SIGNATURE_SIZE) {
    throw new RangeError("header or signature of the wrong length");
  }
  const image = new Uint8Array(header.length + program.length + signature.length);
  image.set(header, 0);
  image.set(program, header.length);
  image.set(signature, header.length + program.length);
  return image;
}

function rejectFormat(message: string): ImageDecoding {
  return { valid: false, reason: "format", message };
}

/**
 * Checks conditions 1, 2, 3 and 5 of docs/protocol/image.md, in that order, and splits the image.
 * Condition 4, the signature, needs the public key: see verifyImage() in image-signing.ts.
 */
export function decodeImage(bytes: Uint8Array): ImageDecoding {
  if (bytes.length < IMAGE_HEADER_SIZE) {
    return rejectFormat(`La imagen ocupa ${bytes.length} bytes y la cabecera sola ocupa 9.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[2] ?? 0;
  const version = view.getUint32(VERSION_OFFSET, true);
  const programLength = view.getUint16(LENGTH_OFFSET, true);
  const expectedLength = IMAGE_HEADER_SIZE + programLength + IMAGE_SIGNATURE_SIZE;
  if (bytes.length !== expectedLength) {
    return rejectFormat(
      `La imagen ocupa ${bytes.length} bytes y, con un programa de ${programLength} bytes, debería ocupar ${expectedLength}.`,
    );
  }
  if (bytes[0] !== IMAGE_MAGIC[0] || bytes[1] !== IMAGE_MAGIC[1]) {
    return rejectFormat("La imagen no empieza con el número mágico 4A 35 («J5»).");
  }
  if (flags !== IMAGE_FLAGS) {
    return rejectFormat(`El byte de banderas vale ${flags} y tiene que valer 0.`);
  }
  if (version < MINIMUM_IMAGE_VERSION) {
    return rejectFormat("La versión 0 es el programa de fábrica y no tiene imagen.");
  }
  if (programLength < MINIMUM_PROGRAM_SIZE || programLength > MAXIMUM_PROGRAM_SIZE) {
    return rejectFormat(
      `El programa ocupa ${programLength} bytes; tiene que ocupar de ${MINIMUM_PROGRAM_SIZE} a ${MAXIMUM_PROGRAM_SIZE}.`,
    );
  }
  const program = bytes.slice(IMAGE_HEADER_SIZE, IMAGE_HEADER_SIZE + programLength);
  const check = checkProgram(program);
  if (!check.valid) {
    return {
      valid: false,
      reason: "program",
      message: `El programa no pasa la validación de la VM: ${check.fault} en la dirección ${check.address}.`,
      fault: check.fault,
      address: check.address,
    };
  }
  return {
    valid: true,
    image: {
      flags,
      version,
      programLength,
      header: bytes.slice(0, IMAGE_HEADER_SIZE),
      program,
      signature: bytes.slice(IMAGE_HEADER_SIZE + programLength),
    },
  };
}

/** Two lowercase hexadecimal digits per byte, as `load_image` takes the image. */
export function formatHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The bytes of a text with two hexadecimal digits per byte, or null if it is not one. */
export function parseHex(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) {
    return null;
  }
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; ++index) {
    bytes[index] = Number.parseInt(text.slice(2 * index, 2 * index + 2), 16);
  }
  return bytes;
}

/**
 * The version the panel proposes when it signs an image: the Unix UTC time in seconds
 * (ADR 0011). `nowMilliseconds` is milliseconds since 1970, as Date.now() gives it.
 */
export function proposeImageVersion(nowMilliseconds: number): number {
  return Math.floor(nowMilliseconds / 1000);
}
