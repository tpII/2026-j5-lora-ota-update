import { describe, expect, it } from "vite-plus/test";
import { assemble } from "./assembler.ts";
import { disassemble } from "./disassembler.ts";
import { parseHex } from "$lib/utils/hex.ts";
import signedImageVector from "../../../../firmware/protocol/test-vectors/signed-image.json";

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
      codeOf("SLEEP 4294967295\nSLEEP 0\nPRINT R1"),
      parseHex(signedImageVector.program) ?? new Uint8Array(),
    ]) {
      const result = disassemble(code);
      if (!result.valid) {
        throw new Error("the program does not disassemble");
      }
      expect(codeOf(result.source)).toEqual(code);
    }
  });

  it("names each jump and call target with a label", () => {
    const code = codeOf(
      "LOAD R2, 3\nloop: SUBI R2, 1\nCALL show\nJNZ R2, loop\nHALT\nshow: PRINT R2\nRET",
    );
    const result = disassemble(code);
    expect(result).toEqual({
      valid: true,
      source:
        "    LOAD R2, 3\nL6:\n    SUBI R2, 1\n    CALL L20\n    JNZ R2, L6\n    HALT\nL20:\n    PRINT R2\n    RET\n",
    });
    if (result.valid) {
      expect(codeOf(result.source)).toEqual(code);
    }
  });

  it("rejects a program the node would reject", () => {
    expect(disassemble(new Uint8Array([0x02, 0x01, 0x05]))).toEqual({
      valid: false,
      address: 0,
      defect: "truncated_instruction",
    });
    expect(disassemble(new Uint8Array([0x01, 0x05]))).toMatchObject({
      valid: false,
      defect: "invalid_register",
    });
  });
});
