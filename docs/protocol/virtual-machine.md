# Máquina virtual

Contrato de la micro VM que ejecuta cada nodo ([ADR 0008](../adrs/0008-register-virtual-machine.md)). El panel de control tiene un intérprete de referencia con la misma semántica, en `control/src/lib/vm/virtual-machine.ts`.

## Estado

| Elemento | Descripción |
|---|---|
| R1 a R4 | Registros de 32 bits con signo; se conservan cuando el programa vuelve a empezar y solo cambian con el programa o con `load_registers` |
| PC | Dirección de la próxima instrucción, desde 0 |
| Pila de retorno | 8 niveles, para `CALL` y `RET` (`returnStackDepth`); se vacía cada vez que el programa arranca |
| Memoria de programa | 1024 bytes (`programCapacity` en `firmware/protocol/contract.json`, que el generador escribe como `PROGRAM_CAPACITY`) |
| Versión | Entero de 32 bits sin signo; 0 es el programa de fábrica, que está vacío |

## Ejecución

- El programa arranca desde la dirección 0 apenas se activa y corre sin fin: no hay tick ni tope de instrucciones.
- El nodo lo ejecuta en bloques de 64 instrucciones por vuelta del bucle principal, intercalados con la radio, así que un lazo infinito no impide que el nodo siga en la red.
- `SLEEP n` detiene la VM durante n milisegundos. Mientras tanto el nodo sigue atendiendo la radio y la consola; la VM retoma en la instrucción siguiente cuando pasa la espera.
- Después de cada `PRINT`, la VM no avanza durante 100 ms (`VM_MINIMUM_PRINT_INTERVAL_MS`). Un lazo que imprime saca como máximo diez salidas por segundo y ninguna se pierde.
- `HALT` o una falla detienen el programa. A los 10 s (`VM_RESTART_DELAY_MS`) vuelve a arrancar desde la dirección 0, con los registros que tenía y la pila de retorno vacía. Al detenerse, el nodo escribe en el OLED y en la consola `VM: HALT stop-reset` tras `HALT`, o `VM:` seguido del motivo tras una falla.
- Activar un programa detiene el que corría, aunque esté esperando por un `SLEEP`, y vuelve a contar los arranques y las salidas desde 1; los registros no cambian.

## Codificación

Cada instrucción empieza con un byte de opcode. Los registros se codifican de 1 a 4, los inmediatos son enteros de 32 bits en little-endian, con signo salvo el de `SLEEP`, y las direcciones son absolutas, de 16 bits en little-endian.

| Forma | Bytes | Ejemplo |
|---|---|---|
| Sin operandos | `[op]` | `HALT` |
| Un registro | `[op][r]` | `PRINT R1` |
| Registro e inmediato | `[op][rd][n n n n]` | `ADDI R1, 5` |
| Dos registros | `[op][rd][rs]` | `ADDR R1, R2` |
| Inmediato sin signo | `[op][n n n n]` | `SLEEP 500` |
| Dirección | `[op][a a]` | `JMP loop` |
| Registro y dirección | `[op][r][a a]` | `JZ R1, end` |

## Instrucciones

En los grupos `0x1n` y `0x2n`, un opcode par toma un inmediato y el impar que le sigue toma un registro fuente. `x` es el inmediato o el registro fuente y `a` es una dirección.

| Opcode | Mnemónico | Efecto |
|---|---|---|
| `00` | `HALT` | Detiene el programa, que vuelve a arrancar a los 10 s |
| `01` | `PRINT r` | Muestra el registro en el OLED y en la consola: `VM: R1 - 0x00000008` |
| `02` | `LOAD rd, n` | rd = n |
| `03` | `SLEEP n` | Espera n milisegundos, de 0 a 4294967295, y sigue en la instrucción siguiente |
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
| `30` | `JMP a` | PC = a |
| `31` | `JZ r, a` | Si r = 0, PC = a |
| `32` | `JNZ r, a` | Si r ≠ 0, PC = a |
| `33` | `JNEG r, a` | Si r < 0, PC = a |
| `34` | `CALL a` | Guarda en la pila de retorno la dirección de la instrucción siguiente y PC = a |
| `35` | `RET` | PC = la dirección que saca de la pila de retorno |

Las sumas, las restas y los productos dan la vuelta en complemento a dos. −2147483648 / −1 da −2147483648 y −2147483648 % −1 da 0. Para saltar según la comparación de dos valores, se restan en un registro y se salta según el resultado.

En `firmware/protocol/contract.json`, cada instrucción lleva su forma y su efecto (`instructionEffects`): `halt` detiene el programa, `print` muestra un registro, `write` escribe el primer registro, `divide` lo escribe después de una división, que falla con un divisor 0, `sleep` espera, `jump` salta, `branch` salta si el registro cumple la condición del opcode, `call` llama a una subrutina y `return` vuelve de ella. Cada efecto admite solo las formas que le dan los operandos que lee, y el generador rechaza una instrucción con una forma que su efecto no admite.

## Validación

Antes de aceptar un programa, el nodo y el panel lo recorren entero y lo rechazan con el primer defecto que encuentran (`programDefects` en el contrato), con la dirección de la instrucción:

| Defecto | Causa |
|---|---|
| `invalid_opcode` | Opcode desconocido |
| `invalid_register` | Registro fuera de 1 a 4 |
| `truncated_instruction` | La última instrucción queda cortada por el final del programa |
| `invalid_jump_target` | Un salto o una llamada a una dirección que no es el comienzo de una instrucción del programa |

Un programa válido nunca ejecuta ninguno de estos casos, así que no son fallas.

## Fallas

Una falla detiene el programa, deja el PC en la dirección de la instrucción que falló y el nodo emite `vm_fault`. El código es el valor de los bits 0 a 2 del byte `vm` del HELLO ([trama](frame.md)).

| Código | Motivo | Causa |
|---|---|---|
| 1 | `division_by_zero` | `DIV` o `MOD` con divisor 0 |
| 2 | `end_of_program` | El PC llegó al final del programa sin pasar por HALT |
| 3 | `stack_overflow` | `CALL` con los 8 niveles de la pila de retorno ocupados |
| 4 | `stack_underflow` | `RET` con la pila de retorno vacía |

## Lenguaje ensamblador

El panel ensambla el programa antes de firmarlo como imagen. Va una instrucción por línea, con los operandos separados por comas o espacios. Los registros se escriben de `R1` a `R4` y los enteros en decimal o en hexadecimal con `0x`, de −2147483648 a 4294967295; por encima de 2147483647 se guarda el patrón de bits. Los milisegundos de `SLEEP` van de 0 a 4294967295 y no admiten negativos. Los comentarios empiezan con `;;`. Los mnemónicos no distinguen mayúsculas.

Una etiqueta es un nombre seguido de `:` al comienzo de una línea, sola o antes de una instrucción, y nombra la dirección de la instrucción siguiente. Empieza con una letra o `_`, sigue con letras, dígitos o `_` y distingue mayúsculas. No puede repetirse ni llamarse como un mnemónico o un registro. Los saltos y las llamadas toman una etiqueta o una dirección numérica.

```
;; Counts from 1 to 5, then waits 10 s and counts again from 6
        LOAD R2, 5          ;; R2 = 5
loop:   ADDI R1, 1          ;; R1 = R1 + 1
        CALL show
        SUBI R2, 1
        JNZ R2, loop
        HALT
show:   PRINT R1
        RET
```

Se ensambla en `020205000000 100101000000 341a00 120201000000 32020600 00 0101 35`, 29 bytes. Para ejecutarlo en un nodo, el panel lo empaqueta con su cabecera y lo firma como imagen ([imagen](image.md)), lo carga con `load_image` y lo activa con `activate` ([consola](console.md)).
