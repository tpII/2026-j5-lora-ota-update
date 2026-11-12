/**
 * Assembler of the virtual machine's language: one instruction per line, operands separated by
 * commas or spaces, registers R1 to R(REGISTER_COUNT), integers in decimal or with 0x, and comments
 * after COMMENT_MARKER. A label ends with ":" at the start of a line and names the address of the
 * next instruction; jumps and calls take a label or an address.
 *
 *             LOAD R2, 5      ;; R2 = 5
 *     loop:   ADDI R1, 1
 *             PRINT R1
 *             SUBI R2, 1
 *             JNZ R2, loop
 *             HALT
 */
import {
  MAXIMUM_REGISTER_VALUE,
  MINIMUM_REGISTER_VALUE,
  PROGRAM_CAPACITY,
  REGISTER_COUNT,
} from "$lib/protocol/protocol-contract.ts";
import {
  INSTRUCTION_BY_MNEMONIC,
  addressOffsetOfForm,
  lengthOfForm,
  registerCountOfForm,
  type InstructionDefinition,
} from "./instruction-set.ts";

export const COMMENT_MARKER = ";;";

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
  /** Labels that name this address. */
  readonly labels: readonly string[];
  /** The instruction as written, without its labels or comment. */
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
const LABEL_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/;
const REGISTER_NAME_PATTERN = /^R[0-9]+$/i;
const MAXIMUM_ADDRESS = 0xffff;

/**
 * An integer written in decimal or in hexadecimal with 0x, optionally negative, from
 * MINIMUM_REGISTER_VALUE to MAXIMUM_REGISTER_VALUE. Returns the signed 32-bit value it stands
 * for, or null.
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
  if (
    !Number.isSafeInteger(value) ||
    value < MINIMUM_REGISTER_VALUE ||
    value > MAXIMUM_REGISTER_VALUE
  ) {
    return null;
  }
  return value | 0;
}

function parseRegister(text: string): number | null {
  const match = /^R([1-9])$/i.exec(text);
  const register = match === null ? null : Number(match[1]);
  return register !== null && register <= REGISTER_COUNT ? register : null;
}

/** An instruction line after the first pass, with its address and the labels before it. */
interface ParsedInstruction {
  readonly line: number;
  readonly address: number;
  readonly labels: readonly string[];
  readonly source: string;
  readonly instruction: InstructionDefinition;
  readonly operands: readonly string[];
}

function operandCountOf(instruction: InstructionDefinition): number {
  const immediates =
    instruction.form === "register-immediate" || instruction.form === "immediate" ? 1 : 0;
  const addresses = addressOffsetOfForm(instruction.form) === null ? 0 : 1;
  return registerCountOfForm(instruction.form) + immediates + addresses;
}

/** A target written as a label or as a number from 0 to MAXIMUM_ADDRESS. */
function resolveAddress(
  text: string,
  labels: ReadonlyMap<string, number>,
  line: number,
  problems: AssemblyProblem[],
): number | null {
  const labelAddress = labels.get(text);
  if (labelAddress !== undefined) {
    return labelAddress;
  }
  if (INTEGER_PATTERN.test(text) && !text.startsWith("-")) {
    const value = Number(text);
    if (Number.isSafeInteger(value) && value <= MAXIMUM_ADDRESS) {
      return value;
    }
  }
  problems.push({ line, message: `La etiqueta «${text}» no está definida.` });
  return null;
}

function encodeInstruction(
  parsed: ParsedInstruction,
  labels: ReadonlyMap<string, number>,
  instructionStarts: ReadonlySet<number>,
  problems: AssemblyProblem[],
): Uint8Array | null {
  const { instruction, operands, line } = parsed;
  const bytes = new Uint8Array(lengthOfForm(instruction.form));
  const view = new DataView(bytes.buffer);
  bytes[0] = instruction.opcode;
  const expected = operandCountOf(instruction);
  if (operands.length !== expected) {
    const noun = expected === 1 ? "operando" : "operandos";
    problems.push({ line, message: `${instruction.mnemonic} lleva ${expected} ${noun}.` });
    return null;
  }
  const registerCount = registerCountOfForm(instruction.form);
  for (let index = 0; index < registerCount; ++index) {
    const register = parseRegister(operands[index] ?? "");
    if (register === null) {
      problems.push({
        line,
        message: `«${operands[index]}» no es un registro: van de R1 a R${REGISTER_COUNT}.`,
      });
      return null;
    }
    bytes[1 + index] = register;
  }
  if (instruction.form === "register-immediate") {
    const value = parseInteger(operands[1] ?? "");
    if (value === null) {
      problems.push({
        line,
        message: `«${operands[1]}» no es un entero de 32 bits (decimal o con 0x).`,
      });
      return null;
    }
    view.setInt32(2, value, true);
  } else if (instruction.form === "immediate") {
    // The milliseconds of SLEEP are unsigned: a negative value is a mistake, not a long wait.
    const text = operands[0] ?? "";
    const value = text.startsWith("-") ? null : parseInteger(text);
    if (value === null) {
      problems.push({
        line,
        message: `«${text}» no es un entero de 0 a ${MAXIMUM_REGISTER_VALUE} (decimal o con 0x).`,
      });
      return null;
    }
    view.setUint32(1, value >>> 0, true);
  }
  const addressOffset = addressOffsetOfForm(instruction.form);
  if (addressOffset !== null) {
    const text = operands[registerCount] ?? "";
    const target = resolveAddress(text, labels, line, problems);
    if (target === null) {
      return null;
    }
    if (!instructionStarts.has(target)) {
      problems.push({
        line,
        message: `El destino «${text}» (dirección ${target}) no es el comienzo de una instrucción.`,
      });
      return null;
    }
    view.setUint16(addressOffset, target, true);
  }
  return bytes;
}

/** Splits the labels off the start of a line; a line may hold only labels. */
function splitLabels(text: string): { readonly labels: string[]; readonly rest: string } {
  const labels: string[] = [];
  let rest = text;
  for (let match = LABEL_PATTERN.exec(rest); match !== null; match = LABEL_PATTERN.exec(rest)) {
    labels.push(match[1] ?? "");
    rest = (match[2] ?? "").trim();
  }
  return { labels, rest };
}

function isAcceptedLabel(
  label: string,
  defined: ReadonlyMap<string, number>,
  line: number,
  problems: AssemblyProblem[],
): boolean {
  if (INSTRUCTION_BY_MNEMONIC.has(label.toUpperCase()) || REGISTER_NAME_PATTERN.test(label)) {
    problems.push({
      line,
      message: `«${label}» es un mnemónico o un registro y no puede ser etiqueta.`,
    });
    return false;
  }
  if (defined.has(label)) {
    problems.push({ line, message: `La etiqueta «${label}» ya está definida.` });
    return false;
  }
  return true;
}

export function assemble(source: string): AssemblyResult {
  const problems: AssemblyProblem[] = [];
  const labels = new Map<string, number>();
  const parsed: ParsedInstruction[] = [];
  let pendingLabels: string[] = [];
  let address = 0;

  // First pass: the addresses of the instructions and of the labels.
  source.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    const text = (rawLine.split(COMMENT_MARKER)[0] ?? "").trim();
    const { labels: lineLabels, rest } = splitLabels(text);
    for (const label of lineLabels) {
      if (isAcceptedLabel(label, labels, line, problems)) {
        labels.set(label, address);
        pendingLabels.push(label);
      }
    }
    if (rest === "") {
      return;
    }
    const [mnemonic = "", ...operands] = rest.replaceAll(",", " ").split(/\s+/);
    const instruction = INSTRUCTION_BY_MNEMONIC.get(mnemonic.toUpperCase());
    if (instruction === undefined) {
      problems.push({ line, message: `La instrucción «${mnemonic}» no existe.` });
      return;
    }
    parsed.push({ line, address, labels: pendingLabels, source: rest, instruction, operands });
    pendingLabels = [];
    address += lengthOfForm(instruction.form);
  });

  // Second pass: the operands, now that every label has its address.
  const instructionStarts = new Set(parsed.map((instruction) => instruction.address));
  const instructions: AssembledInstruction[] = [];
  for (const instruction of parsed) {
    const bytes = encodeInstruction(instruction, labels, instructionStarts, problems);
    if (bytes !== null) {
      instructions.push({
        line: instruction.line,
        address: instruction.address,
        labels: instruction.labels,
        source: instruction.source,
        bytes,
      });
    }
  }

  if (problems.length === 0 && address === 0) {
    problems.push({ line: 1, message: "El programa no tiene instrucciones." });
  }
  if (address > PROGRAM_CAPACITY) {
    problems.push({
      line: parsed.at(-1)?.line ?? 1,
      message: `El programa ocupa ${address} bytes y el nodo admite ${PROGRAM_CAPACITY}.`,
    });
  }
  if (problems.length > 0) {
    return {
      valid: false,
      problems: problems.toSorted((first, second) => first.line - second.line),
    };
  }
  const code = new Uint8Array(address);
  for (const instruction of instructions) {
    code.set(instruction.bytes, instruction.address);
  }
  return { valid: true, code, instructions };
}
