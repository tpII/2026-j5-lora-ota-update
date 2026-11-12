/** Spanish texts for the faults of the VM, for every view that tells why a program stopped. */
import type { VmFault } from "./virtual-machine.ts";

export const VM_FAULT_LABELS: { readonly [Fault in VmFault]: string } = {
  division_by_zero: "división por cero",
  instruction_limit: "se superó el tope de instrucciones del tick",
  end_of_program: "el programa terminó sin HALT",
  invalid_opcode: "opcode inválido",
  invalid_register: "registro inválido",
  truncated_instruction: "instrucción incompleta al final del programa",
};

/** Where and why the VM rejects a program: "división por cero en la dirección 12". */
export function describeProgramFault(fault: VmFault, address: number): string {
  return `${VM_FAULT_LABELS[fault]} en la dirección ${address}`;
}
