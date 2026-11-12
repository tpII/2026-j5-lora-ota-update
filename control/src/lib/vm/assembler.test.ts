import { describe, expect, it } from "vite-plus/test";
import { PROGRAM_CAPACITY } from "$lib/protocol/protocol-contract.ts";
import { assemble, parseInteger } from "./assembler.ts";
import { formatPrintLine } from "./instruction-set.ts";
import { formatHex } from "$lib/utils/hex.ts";

function hexOf(source: string): string {
  const result = assemble(source);
  if (!result.valid) {
    throw new Error(result.problems.map((problem) => problem.message).join(" "));
  }
  return formatHex(result.code);
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
    ).toBe(
      "020105000000" +
        "020203000000" +
        "110102" +
        "0101" +
        "12010a000000" +
        "150102" +
        "0101" +
        "00",
    );
  });

  it("takes commas or spaces, lowercase mnemonics and hexadecimal or negative immediates", () => {
    expect(hexOf("andi r4 0xFFFFFFFF\nshri R2,-1\nnot R3")).toBe(
      "2004ffffffff" + "2802ffffffff" + "2a03",
    );
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

describe("assemble with labels", () => {
  it("resolves labels before and after their use", () => {
    expect(
      hexOf(`
            LOAD R2, 5
        loop:
            ADDI R1, 1
            PRINT R1
            SUBI R2, 1
            JNZ R2, loop
            CALL done
            JMP loop
        done: RET
      `),
    ).toBe(
      "020205000000" +
        "100101000000" +
        "0101" +
        "120201000000" +
        "32020600" +
        "341e00" +
        "300600" +
        "35",
    );
  });

  it("attaches the labels to the next instruction", () => {
    const result = assemble("start:\nfirst: second: NOT R1\nJMP start");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.instructions.map(({ labels, source }) => [labels, source])).toEqual([
        [["start", "first", "second"], "NOT R1"],
        [[], "JMP start"],
      ]);
    }
  });

  it("takes a numeric address that starts an instruction", () => {
    expect(hexOf("NOT R1\nJZ R1, 0")).toBe("2a01" + "31010000");
    expect(assemble("NOT R1\nJMP 1").valid).toBe(false);
  });

  it("reports undefined, repeated and reserved labels with their line", () => {
    const result = assemble("JMP nowhere\nhere: NOT R1\nhere: NOT R2\nr1: HALT\nJMP: HALT\nlast:");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.problems.map((problem) => problem.line)).toEqual([1, 3, 4, 5]);
    }
  });

  it("refuses a jump to a label after the last instruction", () => {
    expect(assemble("JMP end\nend:").valid).toBe(false);
  });
});

describe("assemble SLEEP", () => {
  it("encodes the milliseconds as a 32-bit unsigned integer", () => {
    expect(hexOf("SLEEP 10")).toBe("030a000000");
    expect(hexOf("sleep 0xFFFFFFFF")).toBe("03ffffffff");
    expect(hexOf("SLEEP 4294967295")).toBe("03ffffffff");
  });

  it("refuses a negative wait, a register and a missing operand", () => {
    expect(assemble("SLEEP -1").valid).toBe(false);
    expect(assemble("SLEEP R1").valid).toBe(false);
    expect(assemble("SLEEP").valid).toBe(false);
    expect(assemble("SLEEP 4294967296").valid).toBe(false);
  });
});
