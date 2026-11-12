import { describe, expect, it } from "vite-plus/test";
import {
  MAXIMUM_IMAGE_SIZE,
  MAXIMUM_IMAGE_VERSION,
  MAXIMUM_PROGRAM_SIZE,
  MINIMUM_IMAGE_SIZE,
  MINIMUM_PROGRAM_SIZE,
} from "$lib/protocol/protocol-contract.ts";
import defaultOperatorKeyPem from "../../../../firmware/protocol/default_operator_key.pem?raw";
import {
  decodeImage,
  encodeImageHeader,
  imageSizeFor,
  proposeImageVersion,
} from "./image-format.ts";
import { formatHex, parseHex } from "$lib/utils/hex.ts";
import {
  DEFAULT_OPERATOR_PUBLIC_KEY,
  buildSignedMessage,
  generateOperatorKeyPair,
  importOperatorPrivateKey,
  signImage,
  type OperatorSigningKey,
} from "./image-signing.ts";
import { verifyImage } from "$lib/testing/image-verification.ts";
import signedImageVector from "../../../../firmware/protocol/test-vectors/signed-image.json";
import { assemble } from "$lib/vm/assembler.ts";

function bytesOf(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = parseHex(hex);
  if (bytes === null) {
    throw new Error(`not hexadecimal: ${hex}`);
  }
  return bytes;
}

async function defaultKey(): Promise<OperatorSigningKey> {
  const result = await importOperatorPrivateKey(defaultOperatorKeyPem);
  if (!result.valid) {
    throw new Error(result.message);
  }
  return result.key;
}

describe("image format", () => {
  it("encodes the header of the test vector", () => {
    const program = bytesOf(signedImageVector.program);
    expect(formatHex(encodeImageHeader(signedImageVector.version, program.length))).toBe(
      signedImageVector.header,
    );
  });

  it("decodes the image of the test vector", () => {
    const decoding = decodeImage(bytesOf(signedImageVector.image));
    expect(decoding.valid).toBe(true);
    if (decoding.valid) {
      expect(decoding.image.version).toBe(signedImageVector.version);
      expect(decoding.image.flags).toBe(0);
      expect(formatHex(decoding.image.program)).toBe(signedImageVector.program);
      expect(formatHex(decoding.image.signature)).toBe(signedImageVector.signature);
    }
  });

  it("sizes the images of the shortest and longest programs as the contract bounds them", () => {
    expect(imageSizeFor(MINIMUM_PROGRAM_SIZE)).toBe(MINIMUM_IMAGE_SIZE);
    expect(imageSizeFor(MAXIMUM_PROGRAM_SIZE)).toBe(MAXIMUM_IMAGE_SIZE);
    expect(imageSizeFor(signedImageVector.programLength)).toBe(
      bytesOf(signedImageVector.image).length,
    );
  });

  it("rejects the format before the program", () => {
    const image = bytesOf(signedImageVector.image);
    expect(decodeImage(image.slice(0, image.length - 1))).toMatchObject({ reason: "format" });
    const badMagic = image.slice();
    badMagic[1] = 0x36;
    expect(decodeImage(badMagic)).toMatchObject({ reason: "format" });
    const badFlags = image.slice();
    badFlags[2] = 1;
    expect(decodeImage(badFlags)).toMatchObject({ reason: "format" });
    const versionZero = image.slice();
    versionZero.fill(0, 3, 7);
    expect(decodeImage(versionZero)).toMatchObject({ reason: "format" });
    expect(decodeImage(new Uint8Array(4))).toMatchObject({ reason: "format" });
  });

  it("rejects a program the VM does not accept", () => {
    const image = bytesOf(signedImageVector.image);
    image[9] = 0xff;
    expect(decodeImage(image)).toMatchObject({
      valid: false,
      reason: "program",
      defect: "invalid_opcode",
      address: 0,
    });
  });

  it("refuses to encode versions and lengths out of range", () => {
    expect(() => encodeImageHeader(0, 1)).toThrow(RangeError);
    expect(() => encodeImageHeader(MAXIMUM_IMAGE_VERSION + 1, 1)).toThrow(RangeError);
    expect(() => encodeImageHeader(1, MINIMUM_PROGRAM_SIZE - 1)).toThrow(RangeError);
    expect(() => encodeImageHeader(1, MAXIMUM_PROGRAM_SIZE + 1)).toThrow(RangeError);
    expect(encodeImageHeader(MAXIMUM_IMAGE_VERSION, MAXIMUM_PROGRAM_SIZE)).toHaveLength(
      bytesOf(signedImageVector.header).length,
    );
  });

  it("parses and formats hexadecimal text", () => {
    expect(parseHex("4A35ff")).toEqual(Uint8Array.of(0x4a, 0x35, 0xff));
    expect(parseHex("4a3")).toBeNull();
    expect(parseHex("zz")).toBeNull();
    expect(formatHex(Uint8Array.of(0x0a, 0xb0))).toBe("0ab0");
  });

  it("proposes the Unix time in seconds as the version", () => {
    expect(proposeImageVersion(Date.UTC(2025, 10, 5))).toBe(signedImageVector.version);
    expect(proposeImageVersion(1_762_300_800_999)).toBe(1_762_300_800);
  });
});

describe("image signing", () => {
  it("imports the default private key and derives its public key", async () => {
    const key = await defaultKey();
    expect(key.publicKey).toBe(DEFAULT_OPERATOR_PUBLIC_KEY);
    expect(key.isDefault).toBe(true);
  });

  it("builds the signed message of the test vector", async () => {
    const message = await buildSignedMessage(
      bytesOf(signedImageVector.header),
      bytesOf(signedImageVector.program),
    );
    expect(formatHex(message)).toBe(signedImageVector.signedMessage);
  });

  it("reproduces byte for byte the image that OpenSSL signed", async () => {
    const image = await signImage(
      bytesOf(signedImageVector.program),
      signedImageVector.version,
      await defaultKey(),
    );
    expect(formatHex(image.slice(-64))).toBe(signedImageVector.signature);
    expect(formatHex(image)).toBe(signedImageVector.image);
  });

  it("verifies the test vector with the default public key", async () => {
    const verification = await verifyImage(bytesOf(signedImageVector.image));
    expect(verification.valid).toBe(true);
  });

  it("rejects an image whose program or signature changed", async () => {
    const image = bytesOf(signedImageVector.image);
    const changedProgram = image.slice();
    // LOAD R1, 5 becomes LOAD R1, 6: still a valid program, but not the signed one.
    changedProgram[11] = 0x06;
    expect(await verifyImage(changedProgram)).toMatchObject({ valid: false, reason: "signature" });
    const changedSignature = image.slice();
    changedSignature[image.length - 1] ^= 0x01;
    expect(await verifyImage(changedSignature)).toMatchObject({
      valid: false,
      reason: "signature",
    });
    expect(await verifyImage(image.slice(0, 20))).toMatchObject({ valid: false, reason: "format" });
  });

  it("reports the program only once the signature is valid", async () => {
    const key = await defaultKey();
    const signedBadProgram = await signImage(Uint8Array.of(0xff), 7, key);
    expect(await verifyImage(signedBadProgram)).toMatchObject({ valid: false, reason: "program" });
  });

  it("generates a pair whose signatures verify with its public key", async () => {
    const pair = await generateOperatorKeyPair();
    expect(pair.key.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(pair.key.isDefault).toBe(false);
    expect(pair.privateKeyPem).toMatch(
      /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----\n$/,
    );
    const reimported = await importOperatorPrivateKey(pair.privateKeyPem);
    expect(reimported).toMatchObject({ valid: true, key: { publicKey: pair.key.publicKey } });
    const image = await signImage(bytesOf(signedImageVector.program), 2, pair.key);
    expect((await verifyImage(image, pair.key.publicKey)).valid).toBe(true);
    expect(await verifyImage(image)).toMatchObject({ valid: false, reason: "signature" });
  });

  it("explains why a file is not a usable private key", async () => {
    expect(await importOperatorPrivateKey("hello")).toMatchObject({ valid: false });
    expect(
      await importOperatorPrivateKey(
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n",
      ),
    ).toMatchObject({ valid: false });
    expect(
      await importOperatorPrivateKey(
        "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
      ),
    ).toMatchObject({ valid: false, message: "La clave privada no es una clave Ed25519." });
  });
});

describe("test vector program", () => {
  it("is the assembly the vector describes", () => {
    const result = assemble(signedImageVector.assembly.split(";").join("\n"));
    expect(result.valid && formatHex(result.code)).toBe(signedImageVector.program);
  });
});
