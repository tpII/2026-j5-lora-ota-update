# Pines GPIO de la VM, solo los que la placa no usa

Los programas de la VM leen y escriben pines GPIO con tres instrucciones del grupo `0x4n`. `PINM r, rp` configura el pin cuyo número está en `rp` como entrada sin pull (`r = 0`) o como salida (`r ≠ 0`). `PINR rd, rp` guarda en `rd` un 1 si el pin está en ALTO y un 0 si está en BAJO. `PINW r, rp` lo pone en ALTO si `r ≠ 0` y en BAJO si `r = 0`. `rp` no lleva el número de GPIO sino el número del pin de la VM, de 0 a 2, que es el mismo en todas las placas. Cada placa lo traduce al GPIO que ocupa la misma posición en su lista `vmPins` del contrato del protocolo ([ADR 0013](0013-machine-readable-protocol-contract.md)):

| Pin de la VM | V2 | V4.3 |
|---|---|---|
| 0 | GPIO 25, LED blanco | GPIO 35, LED blanco |
| 1 | GPIO 22 | GPIO 47 |
| 2 | GPIO 23 | GPIO 48 |

La red distribuye una sola imagen a nodos de los dos modelos de placa, así que un programa tiene que comportarse igual en todos. Por eso el generador exige que todas las placas tengan la misma cantidad de pines, y el LED blanco ocupa el pin 0 en las dos. Los GPIO salieron del mapa de pines oficial de la V4, de la definición de pines del core de Arduino y de las descripciones de terceros de la V2. Ninguno es pin de arranque ni lo usan la radio, el OLED, el USB, la UART de la consola, la etapa de RF, el GNSS o la medición de batería. Un número de pin mayor que 2 o negativo detiene el programa con la falla `invalid_pin` (código 5). `PINR` sobre un pin sin configurar o `PINW` sobre uno que no es salida lo detiene con `pin_mode` (código 6). Cada vez que el programa arranca, por una activación, tras HALT o tras una falla, los pines vuelven a entrada sin pull y quedan sin configurar. Así, cada arranque empieza con sus `PINM` y ningún pin queda manejado por un programa anterior.

## Opciones consideradas

- El número de GPIO en `rp`: un programa quedaría atado a un modelo de placa y fallaría con `invalid_pin` en el otro.
- Un opcode por pin (`PINM_0` a `PINW_2`, con un solo registro): ocupa nueve opcodes en lugar de tres, el pin queda fijo al ensamblar y no se puede calcular, por ejemplo en un bucle, y cada pin nuevo agrega tres opcodes.
- Utilizar rualquier pin GPIO: un programa podría apagar la etapa de RF de la V4.3 (GPIO 7), cortar el bus de la radio o del OLED o reiniciar el nodo, en contra del RF7.
- Leer además los pines que maneja el firmware, como la alimentación de la etapa de RF: leerlos sin reconfigurarlos es posible, pero agrega una segunda lista y un modo de solo lectura que ningún programa necesita todavía.
- Los pines de solo entrada de la V2 (36 a 39): no tienen driver de salida, así que `PINW` no podría funcionar en ellos.
- Configurar el pin en el primer `PINR` o `PINW`, sin instrucción de modo: un programa no podría declarar una entrada sin leerla ni distinguir un error de modo.
- Conservar los modos de los pines entre arranques: un programa que falla y vuelve a empezar podría encontrar una salida manejada desde el arranque anterior.

## Consecuencias

- La lista de pines se cambia en el contrato, y el generador la lleva al firmware, al panel y a las pruebas. Para sumar un pin hay que agregar un GPIO a la lista de cada placa.
- Las fallas nuevas usan los códigos 5 y 6 del byte `vm` del HELLO; queda libre el código 7.
- El intérprete de referencia del panel no necesita elegir placa: muestra cada pin de la VM con su GPIO en las dos. Un programa que usa `PINR` depende del circuito, así que, para comparar sus salidas con las del nodo (M5), el simulador tiene que tener en las entradas los mismos niveles que el circuito del nodo.
- Con un LED o un circuito conectado al pin 0, el LED de la placa comparte la línea.
