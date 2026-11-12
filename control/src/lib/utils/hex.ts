/**
 * Two lowercase hexadecimal digits per byte, as `load_image` takes an image and `program` writes
 * the code.
 */
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
