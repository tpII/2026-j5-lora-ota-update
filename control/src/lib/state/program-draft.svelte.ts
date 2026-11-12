/**
 * The program the operator writes, shared by the Programa and Actualización sections: a program
 * tried on the reference interpreter is the one signed and loaded on the node.
 */
import { assemble, type AssemblyResult } from "$lib/vm/assembler.ts";

export const EXAMPLE_PROGRAM = `;; Example: counts down from 8 to 0 in R1 and prints each value with the subroutine show
        LOAD R1, 8          ;; R1 = 8, the counter
        LOAD R2, 1          ;; R2 = 1, what each step subtracts
loop:   CALL show           ;; print R1
        JZ R1, end          ;; after printing 0, stop
        SUBR R1, R2         ;; R1 = R1 - R2
        SLEEP 1000          ;; wait 1 s between two values
        JMP loop
end:    HALT                ;; the node starts the program again after the restart delay
show:   PRINT R1
        RET
`;

export class ProgramDraft {
  source = $state(EXAMPLE_PROGRAM);
  readonly assembly: AssemblyResult = $derived(assemble(this.source));
}
