/**
 * Disassembler of the virtual machine's code: the inverse of the assembler, so the program a node
 * returns with the `program` command can go back to the editor. Immediates are written in decimal,
 * as signed 32-bit integers, which the assembler reads back to the same bytes.
 */
import { checkProgram, type VmFault } from "./virtual-machine.ts";
import { INSTRUCTION_BY_OPCODE, lengthOfForm } from "./instruction-set.ts";

const INDENTATION = "    ";

export type DisassemblyResult =
  | { readonly valid: true; readonly source: string }
  | { readonly valid: false; readonly address: number; readonly fault: VmFault };

/** One line of assembly per instruction, indented as in the editor's example. */
export function disassemble(code: Uint8Array): DisassemblyResult {
  const check = checkProgram(code);
  if (!check.valid) {
    return { valid: false, address: check.address, fault: check.fault };
  }
  const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const lines: string[] = [];
  for (let address = 0; address < code.length;) {
    const instruction = INSTRUCTION_BY_OPCODE.get(code[address] ?? 0);
    if (instruction === undefined) {
      // checkProgram() already rejects unknown opcodes.
      return { valid: false, address, fault: "invalid_opcode" };
    }
    const target = `R${code[address + 1] ?? 0}`;
    switch (instruction.form) {
      case "none":
        lines.push(`${INDENTATION}${instruction.mnemonic}`);
        break;
      case "register":
        lines.push(`${INDENTATION}${instruction.mnemonic} ${target}`);
        break;
      case "register-register":
        lines.push(`${INDENTATION}${instruction.mnemonic} ${target}, R${code[address + 2] ?? 0}`);
        break;
      case "register-immediate":
        lines.push(
          `${INDENTATION}${instruction.mnemonic} ${target}, ${view.getInt32(address + 2, true)}`,
        );
        break;
    }
    address += lengthOfForm(instruction.form);
  }
  return { valid: true, source: `${lines.join("\n")}\n` };
}
