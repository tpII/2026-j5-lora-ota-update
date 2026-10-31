/**
 * Instruction set of the node's virtual machine, as docs/protocol/virtual-machine.md defines it.
 * The assembler and the reference interpreter share this table.
 */

/** Program memory of the node, in bytes: PROGRAM_CAPACITY in firmware/src/vm/virtual_machine.h. */
export const PROGRAM_CAPACITY = 1024;

export const REGISTER_COUNT = 4;

/** Instruction limit of a tick: VM_MAXIMUM_INSTRUCTIONS_PER_TICK in firmware/src/configuration.h. */
export const MAXIMUM_INSTRUCTIONS_PER_TICK = 10_000;

/** Seconds between two ticks on the node: VM_TICK_PERIOD_MS in firmware/src/configuration.h. */
export const TICK_PERIOD_SECONDS = 10;

/**
 * Operands of an instruction: none (`HALT`), one register (`PRINT R1`), a register and a 32-bit
 * immediate (`ADDI R1, 5`) or two registers (`ADDR R1, R2`).
 */
export type OperandForm = "none" | "register" | "register-immediate" | "register-register";

export interface InstructionDefinition {
  readonly mnemonic: string;
  readonly opcode: number;
  readonly form: OperandForm;
  /** Effect, in Spanish, for the operator. */
  readonly description: string;
}

const BINARY_OPERATIONS = [
  { name: "ADD", opcode: 0x10, symbol: "+" },
  { name: "SUB", opcode: 0x12, symbol: "−" },
  { name: "MUL", opcode: 0x14, symbol: "×" },
  { name: "DIV", opcode: 0x16, symbol: "/" },
  { name: "MOD", opcode: 0x18, symbol: "%" },
  { name: "AND", opcode: 0x20, symbol: "&" },
  { name: "OR", opcode: 0x22, symbol: "|" },
  { name: "XOR", opcode: 0x24, symbol: "^" },
  { name: "SHL", opcode: 0x26, symbol: "<<" },
  { name: "SHR", opcode: 0x28, symbol: ">>" },
] as const;

/** Every instruction, in opcode order. In groups 0x1n and 0x2n the low bit selects the form. */
export const INSTRUCTIONS: readonly InstructionDefinition[] = [
  { mnemonic: "HALT", opcode: 0x00, form: "none", description: "termina el tick" },
  { mnemonic: "PRINT", opcode: 0x01, form: "register", description: "muestra el registro" },
  { mnemonic: "LOAD", opcode: 0x02, form: "register-immediate", description: "rd = n" },
  ...BINARY_OPERATIONS.flatMap(({ name, opcode, symbol }) => [
    {
      mnemonic: `${name}I`,
      opcode,
      form: "register-immediate" as const,
      description: `rd = rd ${symbol} n`,
    },
    {
      mnemonic: `${name}R`,
      opcode: opcode + 1,
      form: "register-register" as const,
      description: `rd = rd ${symbol} rs`,
    },
  ]),
  { mnemonic: "NOT", opcode: 0x2a, form: "register", description: "rd = ~rd" },
];

const LENGTH_OF_FORM: { readonly [Form in OperandForm]: number } = {
  none: 1,
  register: 2,
  "register-immediate": 6,
  "register-register": 3,
};

export const INSTRUCTION_BY_MNEMONIC: ReadonlyMap<string, InstructionDefinition> = new Map(
  INSTRUCTIONS.map((instruction) => [instruction.mnemonic, instruction]),
);

export const INSTRUCTION_BY_OPCODE: ReadonlyMap<number, InstructionDefinition> = new Map(
  INSTRUCTIONS.map((instruction) => [instruction.opcode, instruction]),
);

export function lengthOfForm(form: OperandForm): number {
  return LENGTH_OF_FORM[form];
}

/** Length in bytes of the instruction that starts with `opcode`, or 0 for an unknown opcode. */
export function instructionLength(opcode: number): number {
  const instruction = INSTRUCTION_BY_OPCODE.get(opcode);
  return instruction === undefined ? 0 : LENGTH_OF_FORM[instruction.form];
}

/** Two hexadecimal digits per byte, in lowercase, as `load_program` takes the code. */
export function formatProgramHex(code: Uint8Array): string {
  return Array.from(code, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A register value as eight hexadecimal digits, as the node prints it: 0xFFFFFFFA. */
export function formatRegisterHex(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

/** The line a PRINT writes on the node's display: "VM: R1 - 0x00000008". */
export function formatPrintLine(register: number, value: number): string {
  return `VM: R${register} - ${formatRegisterHex(value)}`;
}
