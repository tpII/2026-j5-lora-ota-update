# Micro VM de registros, ejecutada sin fin en bloques

En el E1 se planteó una micro VM de pila, de alrededor de 30 instrucciones. Se implementa en cambio una máquina de registros: cuatro registros de 32 bits con signo (R1 a R4), un contador de programa, una pila de retorno de 8 niveles y una memoria de programa de 1024 bytes, definida por `programCapacity` en el contrato del protocolo ([ADR 0013](0013-machine-readable-protocol-contract.md)). Los opcodes se agrupan por nibble alto: `0x0n` para las instrucciones de configuración (HALT, PRINT y LOAD) y la espera SLEEP, `0x1n` para las aritméticas, `0x2n` para las lógicas y `0x3n` para las de control: el salto incondicional `JMP`, los saltos según un registro `JZ`, `JNZ` y `JNEG` y las llamadas a subrutinas `CALL` y `RET`, y `0x4n` para las de entrada y salida sobre los pines GPIO de la placa (`PINM`, `PINR` y `PINW`, [ADR 0014](0014-vm-gpio-on-free-pins.md)). En los grupos `0x1n` y `0x2n` el bit bajo elige la variante: 0 toma un inmediato de 32 bits en little-endian y 1 toma un registro fuente. Los saltos y las llamadas llevan una dirección absoluta de 16 bits. El formato está en [la VM](../protocol/virtual-machine.md).

El programa activo corre sin fin desde su activación, sin el tick periódico ni el tope de instrucciones por tick que se plantearon en el E1. El bucle principal lo ejecuta en bloques de 64 instrucciones por vuelta, intercalados con la radio: un lazo infinito no saca al nodo de la red (RF7) y la VM no necesita una tarea propia de FreeRTOS ni sincronizar sus registros con la consola. Tras HALT o una falla, el programa vuelve a empezar desde la dirección 0 a los 10 s, con los registros que tenía y la pila de retorno vacía. Para que el programa marque su ritmo, `SLEEP n` detiene la VM durante n milisegundos sin detener el nodo. Además, la VM no avanza durante los 100 ms que siguen a cada PRINT: aun un lazo que imprime sin SLEEP no puede saturar la consola, y ninguna salida se pierde.

Mientras no exista la OTA, el operador carga el programa con `load_program <versión> <largo> <hex>`, sin la cabecera ni la firma digital. Es el único comando que puede superar los 200 caracteres: el resto de las líneas de consola mantiene ese límite.

[ADR 0011](0011-implicit-activation-without-rollback.md) reemplaza `load_program` por `load_image`, que carga una imagen firmada con el formato de [ADR 0012](0012-image-format-and-operator-key.md) y es ahora el único comando con una línea más larga ([consola](../protocol/console.md)). El resto de esta ADR sigue vigente.

## Opciones consideradas

- Máquina de pila, como se decidió en el E1: se reemplaza por registros, que se leen y se depuran más fácil en la pantalla del nodo.
- Un tick cada 10 s con un tope de 10 000 instrucciones, como se planteó en el E1: servía mientras la VM no tenía saltos; con ellos, el propio programa arma su lazo.
- Ejecutar el programa en cada vuelta del bucle sin límite para PRINT: un lazo con PRINT saturaría la consola con miles de líneas por segundo y se perderían salidas y eventos.
- Confiar el ritmo solo a SLEEP, sin límite para PRINT: un programa que imprime en un lazo sin SLEEP saturaría la consola; el límite la protege sin depender de cada programa.
- Dejar el programa detenido tras HALT o una falla hasta la próxima activación: un programa que falla una vez dejaría de ejecutarse para siempre.
- Saltos que comparan dos valores, o una instrucción de comparación con banderas: los saltos según un registro son más simples, aunque comparar dos valores obliga a restarlos en un registro.
- Una tarea de FreeRTOS en el otro núcleo: suma sincronización con la consola y con el reemplazo del programa, sin ganar nada con programas tan cortos.
- Cargar el programa en partes de 200 caracteres: mantiene un único límite de línea, pero obliga a un protocolo de partes que la OTA reemplazaría.

## Consecuencias

- La carga en el nodo y el intérprete de referencia del panel validan el programa entero antes de aceptarlo: opcodes conocidos, registros de 1 a 4, ninguna instrucción cortada por el final y cada salto o llamada dirigido al comienzo de una instrucción. Un programa rechazado tiene un defecto (`programDefects` en el contrato), no una falla: un programa válido nunca ejecuta un opcode desconocido, un registro fuera de rango ni una instrucción cortada.
- La aritmética da la vuelta en complemento a dos; la división y el resto por cero son fallas, igual que `CALL` con la pila de retorno llena y `RET` con la pila vacía.
- La métrica M5 del E1 se mide sobre la secuencia de salidas, no por ticks: cada `vm_print` lleva su número desde la activación, y la salida n del nodo se compara con la salida n del intérprete de referencia.
- El bit 3 del byte `vm` del HELLO indica si el programa falló desde el HELLO anterior ([ADR 0011](0011-implicit-activation-without-rollback.md)), porque un programa continuo puede no volver a terminar nunca.
- Los códigos de falla del HELLO se renumeraron: quedan `division_by_zero`, `end_of_program`, `stack_overflow` y `stack_underflow`. Un nodo con un firmware anterior informa mal el nombre de la falla de un vecino.
- Un programa que imprime dentro de un cálculo largo se demora 100 ms en cada salida.
- El nodo reserva espacio para la línea larga, hoy la de `load_image`, en el búfer de la serie y en el del bucle; el WebSocket reserva cada línea con su largo.
- La versión activa viaja en el campo `version` del HELLO y no se conserva al reiniciar: el nodo vuelve a la versión 0, el programa de fábrica, que está vacío.
