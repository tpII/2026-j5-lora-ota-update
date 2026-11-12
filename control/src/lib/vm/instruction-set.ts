/**
 * Instruction set of the node's virtual machine, as docs/protocol/virtual-machine.md defines it.
 * The encodings come from the protocol contract; the assembler, the disassembler and the reference
 * interpreter look instructions up here.
 */
import {
  INSTRUCTION_ENCODINGS,
  OPERAND_FORM_LENGTHS,
  type OPERAND_FORMS,
} from "$lib/protocol/protocol-contract.ts";

/**
 * Operands of an instruction: none (`HALT`), one register (`PRINT R1`), a register and a 32-bit
 * immediate (`ADDI R1, 5`) or two registers (`ADDR R1, R2`).
 */
export type OperandForm = (typeof OPERAND_FORMS)[number];

export type InstructionDefinition = (typeof INSTRUCTION_ENCODINGS)[number];

export type Mnemonic = InstructionDefinition["mnemonic"];

export const INSTRUCTION_BY_MNEMONIC: ReadonlyMap<string, InstructionDefinition> = new Map(
  INSTRUCTION_ENCODINGS.map((instruction) => [instruction.mnemonic, instruction]),
);

export const INSTRUCTION_BY_OPCODE: ReadonlyMap<number, InstructionDefinition> = new Map(
  INSTRUCTION_ENCODINGS.map((instruction) => [instruction.opcode, instruction]),
);

export function lengthOfForm(form: OperandForm): number {
  return OPERAND_FORM_LENGTHS[form];
}

/** Length in bytes of the instruction that starts with `opcode`, or 0 for an unknown opcode. */
export function instructionLength(opcode: number): number {
  const instruction = INSTRUCTION_BY_OPCODE.get(opcode);
  return instruction === undefined ? 0 : OPERAND_FORM_LENGTHS[instruction.form];
}

/** A register value as eight hexadecimal digits, as the node prints it: 0xFFFFFFFA. */
export function formatRegisterHex(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

/** The line a PRINT writes on the node's display: "VM: R1 - 0x00000008". */
export function formatPrintLine(register: number, value: number): string {
  return `VM: R${register} - ${formatRegisterHex(value)}`;
}
