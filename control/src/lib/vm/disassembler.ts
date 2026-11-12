/**
 * Disassembler of the virtual machine's code: the inverse of the assembler, so the program a node
 * returns with the `program` command can go back to the editor. Immediates are written in decimal,
 * as signed 32-bit integers (the milliseconds of SLEEP, as unsigned ones), and each jump or call
 * target gets a label named after its address (`L16:`), which the assembler reads back to the same
 * bytes.
 */
import { checkProgram, type ProgramDefect } from "./virtual-machine.ts";
import {
  INSTRUCTION_BY_OPCODE,
  addressOffsetOfForm,
  lengthOfForm,
  type InstructionDefinition,
} from "./instruction-set.ts";

const INDENTATION = "    ";

export type DisassemblyResult =
  | { readonly valid: true; readonly source: string }
  | { readonly valid: false; readonly address: number; readonly defect: ProgramDefect };

function labelOf(address: number): string {
  return `L${address}`;
}

function operandsOf(
  instruction: InstructionDefinition,
  code: Uint8Array,
  view: DataView,
  address: number,
): string {
  const target = `R${code[address + 1] ?? 0}`;
  switch (instruction.form) {
    case "none":
      return "";
    case "register":
      return ` ${target}`;
    case "register-register":
      return ` ${target}, R${code[address + 2] ?? 0}`;
    case "register-immediate":
      return ` ${target}, ${view.getInt32(address + 2, true)}`;
    case "immediate":
      return ` ${view.getUint32(address + 1, true)}`;
    case "address":
      return ` ${labelOf(view.getUint16(address + 1, true))}`;
    case "register-address":
      return ` ${target}, ${labelOf(view.getUint16(address + 2, true))}`;
  }
}

/** One line of assembly per instruction, indented as in the editor's example, and its labels. */
export function disassemble(code: Uint8Array): DisassemblyResult {
  const check = checkProgram(code);
  if (!check.valid) {
    return { valid: false, address: check.address, defect: check.defect };
  }
  const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
  // checkProgram() accepted every opcode of the code.
  const instructions: { readonly address: number; readonly instruction: InstructionDefinition }[] =
    [];
  for (let address = 0; address < code.length;) {
    const instruction = INSTRUCTION_BY_OPCODE.get(code[address]!)!;
    instructions.push({ address, instruction });
    address += lengthOfForm(instruction.form);
  }
  const targets = new Set<number>();
  for (const { address, instruction } of instructions) {
    const offset = addressOffsetOfForm(instruction.form);
    if (offset !== null) {
      targets.add(view.getUint16(address + offset, true));
    }
  }
  const lines: string[] = [];
  for (const { address, instruction } of instructions) {
    if (targets.has(address)) {
      lines.push(`${labelOf(address)}:`);
    }
    lines.push(
      `${INDENTATION}${instruction.mnemonic}${operandsOf(instruction, code, view, address)}`,
    );
  }
  return { valid: true, source: `${lines.join("\n")}\n` };
}
