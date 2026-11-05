/**
 * The operator's signing key and the images signed with it, for the update section. The private
 * key lives only in memory: reloading the panel forgets it, and the panel never stores it.
 */
import {
  generateOperatorKeyPair,
  importOperatorPrivateKey,
  signImage,
  type OperatorSigningKey,
} from "$lib/image/image-signing.ts";

const MAXIMUM_SIGNED_IMAGES = 20;

export type SigningKeyOrigin = "file" | "generated";

/** An image the panel signed in this session. */
export interface SignedImageRecord {
  readonly version: number;
  readonly program: Uint8Array<ArrayBuffer>;
  readonly image: Uint8Array<ArrayBuffer>;
  /** Public key that verifies the signature, as 64 hexadecimal digits. */
  readonly publicKey: string;
  readonly hostTime: number;
}

export class ImageSigningSession {
  key = $state.raw<OperatorSigningKey | null>(null);
  keyOrigin = $state<SigningKeyOrigin | null>(null);
  /** Name of the PEM file the key came from, or of the file offered for a generated key. */
  keyFileName = $state<string | null>(null);
  /** PEM text of a generated key, until the operator forgets it: the only copy is this one. */
  generatedPrivateKeyPem = $state<string | null>(null);
  /** Newest last. */
  signedImages = $state.raw<readonly SignedImageRecord[]>([]);

  /** Imports a private key from the text of a PEM file; returns the problem in Spanish, or null. */
  async importKey(pemText: string, fileName: string): Promise<string | null> {
    const result = await importOperatorPrivateKey(pemText);
    if (!result.valid) {
      return result.message;
    }
    this.key = result.key;
    this.keyOrigin = "file";
    this.keyFileName = fileName;
    this.generatedPrivateKeyPem = null;
    return null;
  }

  async generateKey(): Promise<void> {
    const pair = await generateOperatorKeyPair();
    this.key = pair.key;
    this.keyOrigin = "generated";
    this.keyFileName = "operator_key.pem";
    this.generatedPrivateKeyPem = pair.privateKeyPem;
  }

  forgetKey(): void {
    this.key = null;
    this.keyOrigin = null;
    this.keyFileName = null;
    this.generatedPrivateKeyPem = null;
  }

  /** Signs `program` with `version`; throws when there is no key or a value is out of range. */
  async sign(program: Uint8Array, version: number): Promise<SignedImageRecord> {
    const key = this.key;
    if (key === null) {
      throw new Error("No hay una clave privada del operador cargada.");
    }
    const image = await signImage(program, version, key);
    const record: SignedImageRecord = {
      version,
      program: new Uint8Array(program),
      image,
      publicKey: key.publicKey,
      hostTime: Date.now(),
    };
    const kept = [...this.signedImages, record];
    this.signedImages = kept.slice(Math.max(0, kept.length - MAXIMUM_SIGNED_IMAGES));
    return record;
  }
}
