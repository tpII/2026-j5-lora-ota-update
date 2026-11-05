/**
 * Signature of the images with the operator's Ed25519 key (docs/protocol/image.md, ADR 0012). The
 * panel signs with WebCrypto: the private key comes from a PKCS#8 PEM file, as OpenSSL writes it,
 * and the public key goes to the firmware as 64 hexadecimal digits in J5_OPERATOR_PUBLIC_KEY.
 */
import {
  IMAGE_HEADER_SIZE,
  IMAGE_SIGNATURE_SIZE,
  SIGNED_MESSAGE_SIZE,
  assembleImage,
  decodeImage,
  encodeImageHeader,
  formatHex,
  parseHex,
  type DecodedImage,
  type ImageRejection,
} from "./image-format.ts";

/** Public key of the default pair, whose private key is keys/default_operator_key.pem. */
export const DEFAULT_OPERATOR_PUBLIC_KEY =
  "9b82c16539e90d39d9f1a1f786f30c123d8292453b88bdd271c412230940b573";

export const OPERATOR_PUBLIC_KEY_SIZE = 32;

const ED25519 = { name: "Ed25519" } as const;
const PRIVATE_KEY_LABEL = "PRIVATE KEY";
const PEM_LINE_LENGTH = 64;

/** A private key ready to sign, with the public key that verifies its signatures. */
export interface OperatorSigningKey {
  readonly privateKey: CryptoKey;
  /** 64 lowercase hexadecimal digits, the value of J5_OPERATOR_PUBLIC_KEY. */
  readonly publicKey: string;
  /** True when it is the default pair of the repository, valid only on the bench. */
  readonly isDefault: boolean;
}

export type OperatorKeyImport =
  | { readonly valid: true; readonly key: OperatorSigningKey }
  | { readonly valid: false; readonly message: string };

/** A new pair, with the private key as a PEM file to keep on the operator's computer. */
export interface GeneratedOperatorKeyPair {
  readonly key: OperatorSigningKey;
  /** PKCS#8 PEM text, as `openssl genpkey -algorithm ed25519` writes it. */
  readonly privateKeyPem: string;
}

export type ImageVerification =
  | { readonly valid: true; readonly image: DecodedImage }
  | { readonly valid: false; readonly reason: ImageRejection; readonly message: string };

/** A copy backed by an ArrayBuffer, as WebCrypto takes its arguments. */
function bufferOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function bytesOfBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The DER bytes of the first PEM block with `label`, or null if there is none. */
function derOfPem(text: string, label: string): Uint8Array<ArrayBuffer> | null {
  const pattern = new RegExp(`-----BEGIN ${label}-----([^-]*)-----END ${label}-----`);
  const match = pattern.exec(text);
  if (match === null) {
    return null;
  }
  return bytesOfBase64((match[1] ?? "").replace(/\s+/g, ""));
}

/** PEM text of DER bytes, in lines of 64 characters, ending in a newline. */
function pemOf(der: Uint8Array, label: string): string {
  const body = base64Of(der);
  const lines: string[] = [];
  for (let offset = 0; offset < body.length; offset += PEM_LINE_LENGTH) {
    lines.push(body.slice(offset, offset + PEM_LINE_LENGTH));
  }
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

async function publicKeyOf(privateKey: CryptoKey): Promise<string> {
  // The JWK of an Ed25519 private key carries its public key in `x`.
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const raw = bytesOfBase64((jwk.x ?? "").replace(/-/g, "+").replace(/_/g, "/"));
  if (raw === null || raw.length !== OPERATOR_PUBLIC_KEY_SIZE) {
    throw new Error("the Ed25519 private key does not expose its public key");
  }
  return formatHex(raw);
}

async function signingKeyOf(privateKey: CryptoKey): Promise<OperatorSigningKey> {
  const publicKey = await publicKeyOf(privateKey);
  return { privateKey, publicKey, isDefault: publicKey === DEFAULT_OPERATOR_PUBLIC_KEY };
}

/** Imports an Ed25519 private key from the text of a PKCS#8 PEM file. */
export async function importOperatorPrivateKey(pemText: string): Promise<OperatorKeyImport> {
  if (pemText.includes("ENCRYPTED PRIVATE KEY")) {
    return {
      valid: false,
      message:
        "La clave privada está cifrada con contraseña; el panel solo admite claves sin cifrar.",
    };
  }
  const der = derOfPem(pemText, PRIVATE_KEY_LABEL);
  if (der === null) {
    return {
      valid: false,
      message:
        "El archivo no contiene una clave privada PEM con formato PKCS#8 («BEGIN PRIVATE KEY»).",
    };
  }
  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey("pkcs8", der, ED25519, true, ["sign"]);
  } catch {
    return { valid: false, message: "La clave privada no es una clave Ed25519." };
  }
  return { valid: true, key: await signingKeyOf(privateKey) };
}

/** Generates a new Ed25519 pair for the operator. */
export async function generateOperatorKeyPair(): Promise<GeneratedOperatorKeyPair> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const publicKey = formatHex(raw);
  return {
    key: {
      privateKey: pair.privateKey,
      publicKey,
      isDefault: publicKey === DEFAULT_OPERATOR_PUBLIC_KEY,
    },
    privateKeyPem: pemOf(der, PRIVATE_KEY_LABEL),
  };
}

/** Checks that a text is a public key in the format of J5_OPERATOR_PUBLIC_KEY. */
export function isOperatorPublicKey(text: string): boolean {
  return /^[0-9a-f]{64}$/.test(text);
}

/** The 41 bytes the operator signs: the header followed by the SHA-256 of the program. */
export async function buildSignedMessage(
  header: Uint8Array,
  program: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bufferOf(program)));
  const message = new Uint8Array(SIGNED_MESSAGE_SIZE);
  message.set(header, 0);
  message.set(digest, header.length);
  return message;
}

/**
 * Builds the signed image of `program` with `version`. Throws a RangeError if the version or the
 * program length is out of range; the program itself is not checked here.
 */
export async function signImage(
  program: Uint8Array,
  version: number,
  key: OperatorSigningKey,
): Promise<Uint8Array<ArrayBuffer>> {
  const header = encodeImageHeader(version, program.length);
  const message = await buildSignedMessage(header, program);
  const signature = new Uint8Array(await crypto.subtle.sign(ED25519, key.privateKey, message));
  return assembleImage(header, program, signature);
}

/**
 * Verifies an image as a node does (docs/protocol/image.md): format, signature with
 * `publicKey` (64 hexadecimal digits) and program, in the order of the contract.
 */
export async function verifyImage(
  bytes: Uint8Array,
  publicKey: string = DEFAULT_OPERATOR_PUBLIC_KEY,
): Promise<ImageVerification> {
  const decoding = decodeImage(bytes);
  if (!decoding.valid && decoding.reason === "format") {
    return { valid: false, reason: "format", message: decoding.message };
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
  const verifier = await crypto.subtle.importKey("raw", rawPublicKey, ED25519, false, ["verify"]);
  const message = await buildSignedMessage(header, program);
  if (!(await crypto.subtle.verify(ED25519, verifier, signature, message))) {
    return {
      valid: false,
      reason: "signature",
      message: "La firma no es válida con la clave pública del operador.",
    };
  }
  if (!decoding.valid) {
    return { valid: false, reason: "program", message: decoding.message };
  }
  return { valid: true, image: decoding.image };
}
