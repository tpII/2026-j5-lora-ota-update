import { describe, expect, it } from "vite-plus/test";
import { highlightJsonLine, type HighlightedSegment } from "./console-line-highlighter.ts";

const HELLO_LINE =
  '{"t":2950,"ev":"hello","src":"5C21","rssi":-47.5,"neighbors":[{"id":"3A7F","snr":9.5}],"lna":null}';

function textOf(segments: readonly HighlightedSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

function styleOf(segments: readonly HighlightedSegment[], text: string): string {
  const segment = segments.find((candidate) => candidate.text.includes(text));
  if (segment === undefined) {
    throw new Error(`No segment contains ${text}`);
  }
  return segment.style;
}

describe("highlightJsonLine", () => {
  it("keeps the exact text of the line", () => {
    expect(textOf(highlightJsonLine(HELLO_LINE))).toBe(HELLO_LINE);
  });

  it("colors keys, strings and numbers", () => {
    const segments = highlightJsonLine(HELLO_LINE);
    for (const segment of segments) {
      expect(segment.style).toMatch(/^color:#[0-9A-Fa-f]{6}/);
    }
    expect(styleOf(segments, "hello")).not.toBe(styleOf(segments, "ev"));
    expect(styleOf(segments, "-47.5")).not.toBe(styleOf(segments, "hello"));
  });

  it("joins neighbors that share a style", () => {
    const segments = highlightJsonLine(HELLO_LINE);
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index]?.style).not.toBe(segments[index - 1]?.style);
    }
  });

  it("returns the same segments for a line it already colored", () => {
    expect(highlightJsonLine(HELLO_LINE)).toBe(highlightJsonLine(HELLO_LINE));
  });

  it("keeps the text of a line that is not JSON", () => {
    expect(textOf(highlightJsonLine("hello 5C21 -48 dBm"))).toBe("hello 5C21 -48 dBm");
  });
});
