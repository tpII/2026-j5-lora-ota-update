# Micro VM de registros, ejecutada por ticks en porciones

En el E1 se planteó una micro VM de pila, de alrededor de 30 instrucciones. Se implementa en cambio una máquina de registros: cuatro registros de 32 bits con signo (R1 a R4), un contador de programa y una memoria de programa de 1024 bytes, definida por el valor de `PROGRAM_CAPACITY`. Los opcodes se agrupan por nibble alto: `0x0n` para las instrucciones de configuración (HALT, PRINT y LOAD), `0x1n` para las aritméticas, `0x2n` para las lógicas y `0x3n`, reservado, para las de control. En los grupos `0x1n` y `0x2n` el bit bajo elige la variante: 0 toma un inmediato de 32 bits en little-endian y 1 toma un registro fuente. El formato está en [la VM](../protocol/virtual-machine.md).

El programa activo corre un tick cada 10 s, desde la dirección 0 hasta HALT o hasta una falla, y los registros se conservan de un tick al siguiente. El bucle principal ejecuta cada tick en porciones de 64 instrucciones por vuelta, intercaladas con la radio, y un tope de 10 000 instrucciones por tick lo corta con una falla. Así la VM no necesita una tarea propia de FreeRTOS ni sincronizar sus registros con la consola, y un programa defectuoso no saca al nodo de la red (RF7).

Mientras no exista la OTA, el operador carga el programa con `load_program <versión> <largo> <hex>`, sin la cabecera ni la firma digital. Es el único comando que puede superar los 200 caracteres: el resto de las líneas de consola mantiene ese límite.

## Opciones consideradas

- Máquina de pila, como se decidió en el E1: se reemplaza por registros, que se leen y se depuran más fácil en la pantalla del nodo.
- Ejecutar el programa en cada vuelta del bucle: los PRINT saturarían la consola con miles de líneas por segundo.
- Una tarea de FreeRTOS en el otro núcleo: suma sincronización con la consola y con el reemplazo del programa, sin ganar nada con programas tan cortos.
- Cargar el programa en partes de 200 caracteres: mantiene un único límite de línea, pero obliga a un protocolo de partes que la OTA reemplazaría.

## Consecuencias

- La carga en el nodo y el intérprete de referencia del panel validan el programa entero antes de aceptarlo: opcodes conocidos, registros de 1 a 4 y ninguna instrucción cortada por el final.
- La aritmética da la vuelta en complemento a dos; la división y el resto por cero son fallas del tick.
- El nodo reserva 2 KB más para la línea larga, en el búfer de la serie y en el del bucle; el WebSocket reserva cada línea con su largo.
- La versión activa viaja en el campo `version` del HELLO y no se conserva al reiniciar: el nodo vuelve a la versión 0, el programa de fábrica, que está vacío.
