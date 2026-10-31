import { describe, expect, it } from "vite-plus/test";
import { assemble, parseInteger } from "./assembler.ts";
import { PROGRAM_CAPACITY, formatPrintLine, formatProgramHex } from "./instruction-set.ts";

function hexOf(source: string): string {
  const result = assemble(source);
  if (!result.valid) {
    throw new Error(result.problems.map((problem) => problem.message).join(" "));
  }
  return formatProgramHex(result.code);
}

describe("assemble", () => {
  it("encodes every operand form with little-endian immediates", () => {
    expect(
      hexOf(`
        LOAD R1, 5          ;; R1 = 5
        LOAD R2, 3
        ADDR R1, R2
        PRINT R1
        SUBI R1, 10
        MULR R1, R2
        PRINT R1
        HALT
      `),
    ).toBe("020105000000" + "020203000000" + "110102" + "0101" + "12010a000000" + "150102" + "0101" + "00");
  });

  it("takes commas or spaces, lowercase mnemonics and hexadecimal or negative immediates", () => {
    expect(hexOf("andi r4 0xFFFFFFFF\nshri R2,-1\nnot R3")).toBe("2004ffffffff" + "2802ffffffff" + "2a03");
  });

  it("keeps the source line of each instruction and its address", () => {
    const result = assemble(";; header\nLOAD R1, 1\n\nPRINT R1\nHALT");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.instructions.map(({ line, address }) => [line, address])).toEqual([
        [2, 0],
        [4, 6],
        [5, 8],
      ]);
    }
  });

  it("reports every problem with its line", () => {
    const result = assemble("JUMP R1\nLOAD R5, 1\nADDR R1\nLOAD R1, 4294967296\nSUBR R1, 7");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.problems.map((problem) => problem.line)).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it("rejects an empty program and one larger than the program memory", () => {
    expect(assemble(";; nothing").valid).toBe(false);
    expect(assemble("NOT R1\n".repeat(PROGRAM_CAPACITY / 2 + 1)).valid).toBe(false);
    expect(assemble("NOT R1\n".repeat(PROGRAM_CAPACITY / 2)).valid).toBe(true);
  });
});

describe("parseInteger", () => {
  it("reads decimal and hexadecimal values into signed 32-bit integers", () => {
    expect(parseInteger("-2147483648")).toBe(-2147483648);
    expect(parseInteger("4294967295")).toBe(-1);
    expect(parseInteger("0x7FFFFFFF")).toBe(2147483647);
    expect(parseInteger("-0x10")).toBe(-16);
    expect(parseInteger("010")).toBe(10);
  });

  it("refuses values out of range and other text", () => {
    expect(parseInteger("4294967296")).toBeNull();
    expect(parseInteger("-2147483649")).toBeNull();
    expect(parseInteger("1.5")).toBeNull();
    expect(parseInteger("0x")).toBeNull();
    expect(parseInteger("R1")).toBeNull();
  });
});

describe("formatPrintLine", () => {
  it("writes the text of the node's display", () => {
    expect(formatPrintLine(1, 8)).toBe("VM: R1 - 0x00000008");
    expect(formatPrintLine(4, -6)).toBe("VM: R4 - 0xFFFFFFFA");
  });
});
