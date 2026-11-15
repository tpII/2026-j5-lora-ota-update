/** Spanish texts for the faults of the VM and the defects of a program, for every view that tells why a program stopped or was rejected. */
import type { ProgramDefect, VmFault } from "./virtual-machine.ts";

export const VM_FAULT_LABELS: { readonly [Fault in VmFault]: string } = {
  division_by_zero: "división por cero",
  end_of_program: "el programa llegó al final sin HALT",
  stack_overflow: "CALL con la pila de retorno llena",
  stack_underflow: "RET con la pila de retorno vacía",
  invalid_pin: "un número de pin que no es un pin de la VM",
  pin_mode: "PINR sobre un pin sin PINM, o PINW sobre un pin que no es salida",
};

export const PROGRAM_DEFECT_LABELS: { readonly [Defect in ProgramDefect]: string } = {
  invalid_opcode: "opcode inválido",
  invalid_register: "registro inválido",
  truncated_instruction: "instrucción incompleta al final del programa",
  invalid_jump_target: "salto o llamada a una dirección que no es el comienzo de una instrucción",
};

/** Where and why the VM rejects a program: "opcode inválido en la dirección 12". */
export function describeProgramDefect(defect: ProgramDefect, address: number): string {
  return `${PROGRAM_DEFECT_LABELS[defect]} en la dirección ${address}`;
}
