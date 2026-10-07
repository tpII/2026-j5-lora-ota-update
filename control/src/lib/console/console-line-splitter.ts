/**
 * Splits the byte stream of a serial console into lines.
 *
 * Lines end in "\n"; a preceding "\r" is removed. Empty lines are discarded. Bytes that are not
 * valid UTF-8 (for example the boot messages of the ESP32 ROM, sent at another baud rate) are
 * replaced with U+FFFD and end up in debug text lines. A line longer than the maximum length is
 * emitted in pieces so that a stream without line ends cannot exhaust memory.
 */
export class ConsoleLineSplitter {
  readonly #decoder = new TextDecoder("utf-8");
  readonly #maximumLineLength: number;
  #pendingText = "";

  constructor(maximumLineLength = 4096) {
    this.#maximumLineLength = maximumLineLength;
  }

  /** Accepts a chunk of bytes and returns the lines it completes. */
  acceptBytes(chunk: Uint8Array): string[] {
    return this.acceptText(this.#decoder.decode(chunk, { stream: true }));
  }

  /** Accepts a chunk of already decoded text and returns the lines it completes. */
  acceptText(text: string): string[] {
    const lines: string[] = [];
    let remainder = this.#pendingText + text;
    let lineEnd = remainder.indexOf("\n");
    while (lineEnd !== -1) {
      this.#appendLine(lines, remainder.slice(0, lineEnd));
      remainder = remainder.slice(lineEnd + 1);
      lineEnd = remainder.indexOf("\n");
    }
    while (remainder.length > this.#maximumLineLength) {
      this.#appendLine(lines, remainder.slice(0, this.#maximumLineLength));
      remainder = remainder.slice(this.#maximumLineLength);
    }
    this.#pendingText = remainder;
    return lines;
  }

  /** Returns the incomplete line held back, if any, and empties the splitter. */
  flush(): string[] {
    const lines: string[] = [];
    this.#appendLine(lines, this.#pendingText + this.#decoder.decode());
    this.#pendingText = "";
    return lines;
  }

  #appendLine(lines: string[], line: string): void {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.length > 0) {
      lines.push(trimmed);
    }
  }
}
