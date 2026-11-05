import { describe, expect, it } from "vite-plus/test";
import defaultOperatorKeyPem from "../../../../keys/default_operator_key.pem?raw";
import {
  MAXIMUM_IMAGE_SIZE,
  MINIMUM_IMAGE_SIZE,
  decodeImage,
  encodeImageHeader,
  formatHex,
  parseHex,
  proposeImageVersion,
} from "./image-format.ts";
import {
  DEFAULT_OPERATOR_PUBLIC_KEY,
  buildSignedMessage,
  generateOperatorKeyPair,
  importOperatorPrivateKey,
  signImage,
  verifyImage,
  type OperatorSigningKey,
} from "./image-signing.ts";
import {
  TEST_VECTOR_HEADER,
  TEST_VECTOR_IMAGE,
  TEST_VECTOR_PROGRAM,
  TEST_VECTOR_SIGNATURE,
  TEST_VECTOR_SIGNED_MESSAGE,
  TEST_VECTOR_VERSION,
} from "$lib/testing/image-test-vector.ts";
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
    const program = bytesOf(TEST_VECTOR_PROGRAM);
    expect(formatHex(encodeImageHeader(TEST_VECTOR_VERSION, program.length))).toBe(
      TEST_VECTOR_HEADER,
    );
  });

  it("decodes the image of the test vector", () => {
    const decoding = decodeImage(bytesOf(TEST_VECTOR_IMAGE));
    expect(decoding.valid).toBe(true);
    if (decoding.valid) {
      expect(decoding.image.version).toBe(TEST_VECTOR_VERSION);
      expect(decoding.image.flags).toBe(0);
      expect(formatHex(decoding.image.program)).toBe(TEST_VECTOR_PROGRAM);
      expect(formatHex(decoding.image.signature)).toBe(TEST_VECTOR_SIGNATURE);
    }
  });

  it("bounds the image between 74 and 1097 bytes", () => {
    expect(MINIMUM_IMAGE_SIZE).toBe(74);
    expect(MAXIMUM_IMAGE_SIZE).toBe(1097);
  });

  it("rejects the format before the program", () => {
    const image = bytesOf(TEST_VECTOR_IMAGE);
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
    const image = bytesOf(TEST_VECTOR_IMAGE);
    image[9] = 0xff;
    expect(decodeImage(image)).toMatchObject({
      valid: false,
      reason: "program",
      fault: "invalid_opcode",
      address: 0,
    });
  });

  it("refuses to encode versions and lengths out of range", () => {
    expect(() => encodeImageHeader(0, 1)).toThrow(RangeError);
    expect(() => encodeImageHeader(2 ** 32, 1)).toThrow(RangeError);
    expect(() => encodeImageHeader(1, 0)).toThrow(RangeError);
    expect(() => encodeImageHeader(1, 1025)).toThrow(RangeError);
  });

  it("parses and formats hexadecimal text", () => {
    expect(parseHex("4A35ff")).toEqual(Uint8Array.of(0x4a, 0x35, 0xff));
    expect(parseHex("4a3")).toBeNull();
    expect(parseHex("zz")).toBeNull();
    expect(formatHex(Uint8Array.of(0x0a, 0xb0))).toBe("0ab0");
  });

  it("proposes the Unix time in seconds as the version", () => {
    expect(proposeImageVersion(Date.UTC(2025, 10, 5))).toBe(TEST_VECTOR_VERSION);
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
      bytesOf(TEST_VECTOR_HEADER),
      bytesOf(TEST_VECTOR_PROGRAM),
    );
    expect(formatHex(message)).toBe(TEST_VECTOR_SIGNED_MESSAGE);
  });

  it("reproduces byte for byte the image that OpenSSL signed", async () => {
    const image = await signImage(
      bytesOf(TEST_VECTOR_PROGRAM),
      TEST_VECTOR_VERSION,
      await defaultKey(),
    );
    expect(formatHex(image.slice(-64))).toBe(TEST_VECTOR_SIGNATURE);
    expect(formatHex(image)).toBe(TEST_VECTOR_IMAGE);
  });

  it("verifies the test vector with the default public key", async () => {
    const verification = await verifyImage(bytesOf(TEST_VECTOR_IMAGE));
    expect(verification.valid).toBe(true);
  });

  it("rejects an image whose program or signature changed", async () => {
    const image = bytesOf(TEST_VECTOR_IMAGE);
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
    const image = await signImage(bytesOf(TEST_VECTOR_PROGRAM), 2, pair.key);
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
  it("is the assembly its comment describes", () => {
    const result = assemble(
      "LOAD R1, 5\nLOAD R2, 3\nADDR R1, R2\nPRINT R1\nSUBI R1, 10\nMULR R1, R2\nPRINT R1\nHALT",
    );
    expect(result.valid && formatHex(result.code)).toBe(TEST_VECTOR_PROGRAM);
  });
});
