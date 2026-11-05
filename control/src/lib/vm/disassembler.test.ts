import { describe, expect, it } from "vite-plus/test";
import { assemble } from "./assembler.ts";
import { disassemble } from "./disassembler.ts";
import { parseHex } from "$lib/image/image-format.ts";
import { TEST_VECTOR_PROGRAM } from "$lib/testing/image-test-vector.ts";

function codeOf(source: string): Uint8Array {
  const result = assemble(source);
  if (!result.valid) {
    throw new Error(result.problems.map((problem) => problem.message).join(" "));
  }
  return result.code;
}

describe("disassemble", () => {
  it("writes one indented line per instruction, with decimal immediates", () => {
    const code = codeOf("LOAD R1, 0xFFFFFFFA\nADDR R1, R2\nPRINT R1\nNOT R3\nHALT");
    expect(disassemble(code)).toEqual({
      valid: true,
      source: "    LOAD R1, -6\n    ADDR R1, R2\n    PRINT R1\n    NOT R3\n    HALT\n",
    });
  });

  it("gives back the same bytes when the source is assembled again", () => {
    for (const code of [
      codeOf("LOAD R4, -2147483648\nSHRR R4, R1\nMODI R2, 7"),
      parseHex(TEST_VECTOR_PROGRAM) ?? new Uint8Array(),
    ]) {
      const result = disassemble(code);
      if (!result.valid) {
        throw new Error("the program does not disassemble");
      }
      expect(codeOf(result.source)).toEqual(code);
    }
  });

  it("rejects a program the node would reject", () => {
    expect(disassemble(new Uint8Array([0x02, 0x01, 0x05]))).toEqual({
      valid: false,
      address: 0,
      fault: "truncated_instruction",
    });
    expect(disassemble(new Uint8Array([0x01, 0x05]))).toMatchObject({
      valid: false,
      fault: "invalid_register",
    });
  });
});
