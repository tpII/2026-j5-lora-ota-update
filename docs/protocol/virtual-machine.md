# Máquina virtual

Contrato de la micro VM que ejecuta cada nodo ([ADR 0008](../adrs/0008-register-virtual-machine.md)). El panel de control tiene un intérprete de referencia con la misma semántica, en `control/src/lib/vm/virtual-machine.ts`.

## Estado

| Elemento | Descripción |
|---|---|
| R1 a R4 | Registros de 32 bits con signo; se conservan entre ticks y solo cambian con el programa o con `load_registers` |
| PC | Dirección de la próxima instrucción, desde 0 |
| Memoria de programa | 1024 bytes (`PROGRAM_CAPACITY` en `firmware/src/vm/virtual_machine.h`) |
| Versión | Entero de 32 bits sin signo; 0 es el programa de fábrica, que está vacío |

## Ticks

- Un tick ejecuta el programa desde la dirección 0 hasta HALT o hasta una falla.
- El nodo arranca un tick cada 10 s y el primero apenas acepta un programa nuevo. Lo ejecuta en porciones de 64 instrucciones por vuelta del bucle principal, intercaladas con la radio.
- Un tick que ejecuta 10 000 instrucciones termina con la falla `instruction_limit`.
- Cargar un programa corta el tick en curso y vuelve a contar los ticks desde 1; los registros no cambian.

## Codificación

Cada instrucción empieza con un byte de opcode. Los registros se codifican de 1 a 4 y los inmediatos son enteros de 32 bits con signo en little-endian.

| Forma | Bytes | Ejemplo |
|---|---|---|
| Sin operandos | `[op]` | `HALT` |
| Un registro | `[op][r]` | `PRINT R1` |
| Registro e inmediato | `[op][rd][n n n n]` | `ADDI R1, 5` |
| Dos registros | `[op][rd][rs]` | `ADDR R1, R2` |

## Instrucciones

En los grupos `0x1n` y `0x2n`, un opcode par toma un inmediato y el impar que le sigue toma un registro fuente. `x` es el inmediato o el registro fuente.

| Opcode | Mnemónico | Efecto |
|---|---|---|
| `00` | `HALT` | Termina el tick |
| `01` | `PRINT r` | Muestra el registro en el OLED y en la consola: `VM: R1 - 0x00000008` |
| `02` | `LOAD rd, n` | rd = n |
| `10`, `11` | `ADDI`, `ADDR` | rd = rd + x |
| `12`, `13` | `SUBI`, `SUBR` | rd = rd − x |
| `14`, `15` | `MULI`, `MULR` | rd = rd × x |
| `16`, `17` | `DIVI`, `DIVR` | rd = rd / x, truncado hacia cero |
| `18`, `19` | `MODI`, `MODR` | rd = rd % x, con el signo de rd |
| `20`, `21` | `ANDI`, `ANDR` | rd = rd & x |
| `22`, `23` | `ORI`, `ORR` | rd = rd \| x |
| `24`, `25` | `XORI`, `XORR` | rd = rd ^ x |
| `26`, `27` | `SHLI`, `SHLR` | rd = rd << (x & 31) |
| `28`, `29` | `SHRI`, `SHRR` | rd = rd >> (x & 31), con extensión de signo |
| `2A` | `NOT rd` | rd = ~rd |
| `3n` | — | Reservado para las instrucciones de control |

Las sumas, las restas y los productos dan la vuelta en complemento a dos. −2147483648 / −1 da −2147483648 y −2147483648 % −1 da 0.

## Fallas

Una falla termina el tick, deja el PC en la dirección de la instrucción que falló y el nodo emite `vm_fault`.

| Motivo | Causa |
|---|---|
| `division_by_zero` | `DIV` o `MOD` con divisor 0 |
| `instruction_limit` | El tick llegó a 10 000 instrucciones |
| `end_of_program` | El PC llegó al final del programa sin pasar por HALT |
| `invalid_opcode` | Opcode desconocido |
| `invalid_register` | Registro fuera de 1 a 4 |
| `truncated_instruction` | La última instrucción queda cortada por el final del programa |

La carga rechaza de antemano los programas con `invalid_opcode`, `invalid_register` o `truncated_instruction`, así que en la práctica solo aparecen las tres primeras.

## Lenguaje ensamblador

El panel ensambla el programa antes de cargarlo. Va una instrucción por línea, con los operandos separados por comas o espacios. Los registros se escriben de `R1` a `R4` y los enteros en decimal o en hexadecimal con `0x`, de −2147483648 a 4294967295; por encima de 2147483647 se guarda el patrón de bits. Los comentarios empiezan con `;;`. Los mnemónicos no distinguen mayúsculas.

```
;; R1 = 5 + 3, then (R1 - 10) x R2
    LOAD R1, 5
    LOAD R2, 3
    ADDR R1, R2         ;; R1 = 8
    PRINT R1
    SUBI R1, 10         ;; R1 = -2
    MULR R1, R2         ;; R1 = -6
    PRINT R1
    HALT
```

Se ensambla en `020105000000 020203000000 110102 0101 12010a000000 150102 0101 00`, 29 bytes, y se carga con `load_program 1 29 020105000000020203000000110102010112010a000000150102010100`.
