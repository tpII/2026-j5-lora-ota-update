/**
 * Assembler of the virtual machine's language: one instruction per line, operands separated by
 * commas or spaces, registers R1 to R4, integers in decimal or with 0x, and comments after ";;".
 *
 *     LOAD R1, 5      ;; R1 = 5
 *     ADDR R1, R2
 *     PRINT R1
 *     HALT
 */
import {
  INSTRUCTION_BY_MNEMONIC,
  PROGRAM_CAPACITY,
  REGISTER_COUNT,
  lengthOfForm,
  type InstructionDefinition,
} from "./instruction-set.ts";

export const COMMENT_MARKER = ";;";

/** Smallest and largest integer an immediate or a register takes; above 2³¹ − 1 the bit pattern is kept. */
export const MINIMUM_INTEGER = -(2 ** 31);
export const MAXIMUM_INTEGER = 2 ** 32 - 1;

export interface AssemblyProblem {
  /** Line of the source, from 1. */
  readonly line: number;
  /** Description for the operator, in Spanish. */
  readonly message: string;
}

/** One instruction of the program and the source line it comes from. */
export interface AssembledInstruction {
  readonly line: number;
  readonly address: number;
  readonly source: string;
  readonly bytes: Uint8Array;
}

export type AssemblyResult =
  | {
      readonly valid: true;
      readonly code: Uint8Array;
      readonly instructions: readonly AssembledInstruction[];
    }
  | { readonly valid: false; readonly problems: readonly AssemblyProblem[] };

const INTEGER_PATTERN = /^-?(0x[0-9a-f]+|[0-9]+)$/i;

/**
 * An integer written in decimal or in hexadecimal with 0x, optionally negative, from −2³¹ to
 * 2³² − 1. Returns the signed 32-bit value it stands for, or null.
 */
export function parseInteger(text: string): number | null {
  const trimmed = text.trim();
  if (!INTEGER_PATTERN.test(trimmed)) {
    return null;
  }
  const negative = trimmed.startsWith("-");
  const digits = negative ? trimmed.slice(1) : trimmed;
  // Number() reads both forms, and a decimal with leading zeros stays decimal.
  const magnitude = Number(digits);
  const value = negative ? -magnitude : magnitude;
  if (!Number.isSafeInteger(value) || value < MINIMUM_INTEGER || value > MAXIMUM_INTEGER) {
    return null;
  }
  return value | 0;
}

function parseRegister(text: string): number | null {
  const match = /^R([1-9])$/i.exec(text);
  const register = match === null ? null : Number(match[1]);
  return register !== null && register <= REGISTER_COUNT ? register : null;
}

function encodeInstruction(
  instruction: InstructionDefinition,
  operands: readonly string[],
  line: number,
  problems: AssemblyProblem[],
): Uint8Array | null {
  const bytes = new Uint8Array(lengthOfForm(instruction.form));
  bytes[0] = instruction.opcode;
  const expected = instruction.form === "none" ? 0 : instruction.form === "register" ? 1 : 2;
  if (operands.length !== expected) {
    const noun = expected === 1 ? "operando" : "operandos";
    problems.push({ line, message: `${instruction.mnemonic} lleva ${expected} ${noun}.` });
    return null;
  }
  if (expected === 0) {
    return bytes;
  }
  const target = parseRegister(operands[0] ?? "");
  if (target === null) {
    problems.push({ line, message: `«${operands[0]}» no es un registro: van de R1 a R4.` });
    return null;
  }
  bytes[1] = target;
  if (instruction.form === "register-register") {
    const source = parseRegister(operands[1] ?? "");
    if (source === null) {
      problems.push({ line, message: `«${operands[1]}» no es un registro: van de R1 a R4.` });
      return null;
    }
    bytes[2] = source;
  } else if (instruction.form === "register-immediate") {
    const value = parseInteger(operands[1] ?? "");
    if (value === null) {
      problems.push({
        line,
        message: `«${operands[1]}» no es un entero de 32 bits (decimal o con 0x).`,
      });
      return null;
    }
    new DataView(bytes.buffer).setInt32(2, value, true);
  }
  return bytes;
}

export function assemble(source: string): AssemblyResult {
  const problems: AssemblyProblem[] = [];
  const instructions: AssembledInstruction[] = [];
  let address = 0;
  source.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    const text = (rawLine.split(COMMENT_MARKER)[0] ?? "").trim();
    if (text === "") {
      return;
    }
    const [mnemonic = "", ...operands] = text.replaceAll(",", " ").split(/\s+/);
    const instruction = INSTRUCTION_BY_MNEMONIC.get(mnemonic.toUpperCase());
    if (instruction === undefined) {
      problems.push({ line, message: `La instrucción «${mnemonic}» no existe.` });
      return;
    }
    const bytes = encodeInstruction(instruction, operands, line, problems);
    if (bytes !== null) {
      instructions.push({ line, address, source: text, bytes });
      address += bytes.length;
    }
  });
  if (problems.length === 0 && address === 0) {
    problems.push({ line: 1, message: "El programa no tiene instrucciones." });
  }
  if (address > PROGRAM_CAPACITY) {
    problems.push({
      line: instructions.at(-1)?.line ?? 1,
      message: `El programa ocupa ${address} bytes y el nodo admite ${PROGRAM_CAPACITY}.`,
    });
  }
  if (problems.length > 0) {
    return { valid: false, problems };
  }
  const code = new Uint8Array(address);
  for (const instruction of instructions) {
    code.set(instruction.bytes, instruction.address);
  }
  return { valid: true, code, instructions };
}
