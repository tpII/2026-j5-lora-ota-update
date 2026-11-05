/**
 * The program the operator writes, shared by the Programa and Actualización sections: a program
 * tried on the reference interpreter is the one signed and loaded on the node.
 */
import { assemble, type AssemblyResult } from "$lib/vm/assembler.ts";

export const EXAMPLE_PROGRAM = `;; Example: R1 = 5 + 3, then (R1 - 10) x R2
    LOAD R1, 5          ;; R1 = 5
    LOAD R2, 3          ;; R2 = 3
    ADDR R1, R2         ;; R1 = R1 + R2 = 8
    PRINT R1
    SUBI R1, 10         ;; R1 = -2
    MULR R1, R2         ;; R1 = -6
    PRINT R1
    HALT
`;

export class ProgramDraft {
  source = $state(EXAMPLE_PROGRAM);
  readonly assembly: AssemblyResult = $derived(assemble(this.source));
}
