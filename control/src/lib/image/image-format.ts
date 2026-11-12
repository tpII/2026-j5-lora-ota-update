/**
 * Image format of docs/protocol/image.md (ADR 0012): a header with the magic number, the flags, the
 * version and the program length, then the program and the Ed25519 signature of the operator.
 * Multi-byte fields are little-endian.
 */
import type { ImageRejectionReason } from "$lib/console/console-event.ts";
import {
  IMAGE_FLAGS,
  IMAGE_FLAGS_OFFSET,
  IMAGE_FORMAT_DEFECTS,
  IMAGE_HEADER_SIZE,
  IMAGE_MAGIC,
  IMAGE_MAGIC_OFFSET,
  IMAGE_PROGRAM_LENGTH_OFFSET,
  IMAGE_SIGNATURE_SIZE,
  IMAGE_VERSION_OFFSET,
  MAXIMUM_IMAGE_VERSION,
  MAXIMUM_PROGRAM_SIZE,
  MINIMUM_IMAGE_VERSION,
  MINIMUM_PROGRAM_SIZE,
} from "$lib/protocol/protocol-contract.ts";
import { pad } from "$lib/utils/format.ts";
import { checkProgram, type ProgramDefect } from "$lib/vm/virtual-machine.ts";

export interface ImageHeader {
  readonly flags: number;
  readonly version: number;
  /** Program length in bytes. */
  readonly programLength: number;
}

/** An image whose structure is valid; the signature is not checked here. */
export interface DecodedImage extends ImageHeader {
  /** The header bytes, as they are signed. */
  readonly header: Uint8Array<ArrayBuffer>;
  readonly program: Uint8Array<ArrayBuffer>;
  readonly signature: Uint8Array<ArrayBuffer>;
}

/**
 * What decodeImage() finds. A program the VM rejects comes with the first fault and its address,
 * for the caller to describe; a format problem, with the check that failed and its description
 * for the operator, in Spanish.
 */
export type ImageDecoding =
  | { readonly valid: true; readonly image: DecodedImage }
  | {
      readonly valid: false;
      readonly reason: Extract<ImageRejectionReason, "format">;
      readonly defect: ImageFormatDefect;
      readonly message: string;
    }
  | {
      readonly valid: false;
      readonly reason: Extract<ImageRejectionReason, "program">;
      readonly defect: ProgramDefect;
      readonly address: number;
    };

export function isImageVersion(version: number): boolean {
  return (
    Number.isInteger(version) &&
    version >= MINIMUM_IMAGE_VERSION &&
    version <= MAXIMUM_IMAGE_VERSION
  );
}

/** Bytes of the image of a program of `programLength` bytes: header, program and signature. */
export function imageSizeFor(programLength: number): number {
  return IMAGE_HEADER_SIZE + programLength + IMAGE_SIGNATURE_SIZE;
}

/**
 * Fragments an image of `imageSize` bytes travels in with fragments of `fragmentSize` bytes: every
 * fragment is full but the last (docs/protocol/frame.md, `fragmentCountFor` in
 * firmware/src/messages/fragment_message.h).
 */
export function fragmentCountFor(imageSize: number, fragmentSize: number): number {
  return Math.ceil(imageSize / fragmentSize);
}

/**
 * The header of an image with `version` and a program of `programLength` bytes. Throws a
 * RangeError when either is out of range.
 */
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
  header.set(IMAGE_MAGIC, IMAGE_MAGIC_OFFSET);
  header[IMAGE_FLAGS_OFFSET] = IMAGE_FLAGS;
  view.setUint32(IMAGE_VERSION_OFFSET, version, true);
  view.setUint16(IMAGE_PROGRAM_LENGTH_OFFSET, programLength, true);
  return header;
}

/** Throws a RangeError when the header or the signature has the wrong length. */
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

/** The version in the header of an image of at least IMAGE_HEADER_SIZE bytes. */
export function readImageVersion(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    IMAGE_VERSION_OFFSET,
    true,
  );
}

/** A check of the image format, with the name of IMAGE_FORMAT_DEFECTS. */
export type ImageFormatDefect = keyof typeof IMAGE_FORMAT_DEFECTS;

function rejectFormat(defect: ImageFormatDefect, message: string): ImageDecoding {
  return { valid: false, reason: "format", defect, message };
}

/**
 * Checks conditions 1, 2, 3 and 5 of docs/protocol/image.md, in that order, and splits the image.
 * Condition 4, the signature, needs the public key: the nodes check it, and the simulated node of
 * the tests with verifyImage() in testing/image-verification.ts.
 */
export function decodeImage(bytes: Uint8Array): ImageDecoding {
  if (bytes.length < IMAGE_HEADER_SIZE) {
    return rejectFormat(
      "shorterThanHeader",
      `La imagen ocupa ${bytes.length} ${bytes.length === 1 ? "byte" : "bytes"} y la cabecera sola ocupa ${IMAGE_HEADER_SIZE}.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[IMAGE_FLAGS_OFFSET] ?? 0;
  const version = view.getUint32(IMAGE_VERSION_OFFSET, true);
  const programLength = view.getUint16(IMAGE_PROGRAM_LENGTH_OFFSET, true);
  const expectedLength = imageSizeFor(programLength);
  if (bytes.length !== expectedLength) {
    return rejectFormat(
      "lengthMismatch",
      `La imagen ocupa ${bytes.length} bytes y, con un programa de ${programLength} ${programLength === 1 ? "byte" : "bytes"}, debería ocupar ${expectedLength}.`,
    );
  }
  if (IMAGE_MAGIC.some((byte, index) => bytes[IMAGE_MAGIC_OFFSET + index] !== byte)) {
    const magic = IMAGE_MAGIC.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0"));
    const text = String.fromCharCode(...IMAGE_MAGIC);
    return rejectFormat(
      "badMagic",
      `La imagen no empieza con el número mágico ${magic.join(" ")} («${text}»).`,
    );
  }
  if (flags !== IMAGE_FLAGS) {
    return rejectFormat(
      "badFlags",
      `El byte de banderas vale ${flags} y tiene que valer ${IMAGE_FLAGS}.`,
    );
  }
  if (version < MINIMUM_IMAGE_VERSION) {
    return rejectFormat(
      "factoryVersion",
      "La versión 0 es el programa de fábrica y no tiene imagen.",
    );
  }
  if (programLength < MINIMUM_PROGRAM_SIZE || programLength > MAXIMUM_PROGRAM_SIZE) {
    return rejectFormat(
      "programLengthOutOfRange",
      `El programa ocupa ${programLength} bytes; tiene que ocupar de ${MINIMUM_PROGRAM_SIZE} a ${MAXIMUM_PROGRAM_SIZE}.`,
    );
  }
  const program = bytes.slice(IMAGE_HEADER_SIZE, IMAGE_HEADER_SIZE + programLength);
  const check = checkProgram(program);
  if (!check.valid) {
    return { valid: false, reason: "program", defect: check.defect, address: check.address };
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

/**
 * The version the panel proposes when it signs an image: the Unix UTC time in seconds
 * (ADR 0011). `nowMilliseconds` is milliseconds since 1970, as Date.now() gives it.
 */
export function proposeImageVersion(nowMilliseconds: number): number {
  return Math.floor(nowMilliseconds / 1000);
}

/**
 * Date and time on the computer that a version proposed by proposeImageVersion() stands for, in
 * the form 05/11/2025 00:00:00; null for version 0.
 */
export function formatVersionDate(version: number): string | null {
  if (version <= 0) {
    return null;
  }
  const date = new Date(version * 1000);
  return (
    `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
