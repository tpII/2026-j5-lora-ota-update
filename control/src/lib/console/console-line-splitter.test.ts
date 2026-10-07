import { describe, expect, it } from "vite-plus/test";
import { ConsoleLineSplitter } from "./console-line-splitter.ts";

const encoder = new TextEncoder();

describe("ConsoleLineSplitter", () => {
  it("joins lines split across chunks", () => {
    const splitter = new ConsoleLineSplitter();
    expect(splitter.acceptBytes(encoder.encode('{"t":1,"ev":'))).toEqual([]);
    expect(splitter.acceptBytes(encoder.encode('"boot"}\nboot 3A'))).toEqual([
      '{"t":1,"ev":"boot"}',
    ]);
    expect(splitter.acceptBytes(encoder.encode("7F V4.3 e12\n"))).toEqual(["boot 3A7F V4.3 e12"]);
  });

  it("accepts \\r\\n and skips empty lines", () => {
    const splitter = new ConsoleLineSplitter();
    expect(splitter.acceptText("first\r\n\r\n\nsecond\r")).toEqual(["first"]);
    expect(splitter.acceptText("\n")).toEqual(["second"]);
  });

  it("decodes UTF-8 sequences split across chunks", () => {
    const splitter = new ConsoleLineSplitter();
    const bytes = encoder.encode("µs\n");
    expect(splitter.acceptBytes(bytes.slice(0, 1))).toEqual([]);
    expect(splitter.acceptBytes(bytes.slice(1))).toEqual(["µs"]);
  });

  it("replaces bytes that are not UTF-8, such as the ROM messages at another baud rate", () => {
    const splitter = new ConsoleLineSplitter();
    expect(splitter.acceptBytes(new Uint8Array([0xff, 0xfe, 0x41, 0x0a]))).toEqual(["��A"]);
  });

  it("cuts lines that exceed the maximum length", () => {
    const splitter = new ConsoleLineSplitter(4);
    expect(splitter.acceptText("abcdefghij")).toEqual(["abcd", "efgh"]);
    expect(splitter.acceptText("\n")).toEqual(["ij"]);
  });

  it("returns the pending text on flush", () => {
    const splitter = new ConsoleLineSplitter();
    expect(splitter.acceptText("run 3 done")).toEqual([]);
    expect(splitter.flush()).toEqual(["run 3 done"]);
    expect(splitter.flush()).toEqual([]);
  });
});
