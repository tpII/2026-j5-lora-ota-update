# Trama LoRa

Contrato entre nodos, versión 2 del protocolo. Los campos de más de un byte van en little-endian.

## Formato

| Campo | Bytes | Descripción |
|---|---|---|
| `type` | 1 | Tipo de mensaje (ver la tabla de tipos) |
| `source` | 2 | Identificador del nodo que creó el paquete |
| `destination` | 2 | Identificador del destinatario, o `FFFF` para todos |
| `epoch` | 1 | Época del origen |
| `sequence` | 2 | Número de secuencia del origen dentro de su época |
| `payload` | 0 a 239 | Cuerpo, que depende del tipo |
| `tag` | 8 | Etiqueta de autenticación |

La trama ocupa 16 bytes más el cuerpo, con un total de 255 como máximo.

## Identificador del nodo

Es el número de 16 bits que forman los dos últimos bytes de la MAC de fábrica, en el orden en que se imprime la MAC. Se escribe con cuatro dígitos hexadecimales en mayúscula, por ejemplo `3A7F`. `0000` y `FFFF` quedan reservados: si la MAC diera alguno de los dos, el nodo usa `0001` o `FFFE`.

## Época y secuencia

La época es un contador de 8 bits que el nodo guarda en NVS. Aumenta en cada arranque y cada vez que la secuencia da la vuelta. La secuencia, de 16 bits, empieza en 0 en cada época y aumenta con cada paquete que el nodo origina.

## Etiqueta de autenticación

`tag` contiene los primeros 8 bytes de HMAC-SHA256(clave de red, versión ‖ cabecera ‖ cuerpo). La versión es un byte con la versión del protocolo (hoy `0x02`) que entra en el cálculo pero no viaja en la trama ([ADR 0005](../adrs/0005-frame-without-hop-count.md)). Un paquete armado con otra versión del protocolo o con otra clave falla la verificación.

## Claves

La clave de red y la contraseña del punto de acceso se compilan en el firmware:

| Macro | Uso | Valor por defecto |
|---|---|---|
| `J5_NETWORK_KEY` | Clave del HMAC | `"bichofeo"` |
| `J5_ACCESS_POINT_PASSWORD` | Contraseña WPA2 del punto de acceso | `"bichofeo"` |
| `J5_OPERATOR_PUBLIC_KEY` | Clave pública Ed25519 del operador, en hexadecimal ([imagen](image.md)) | La del par de `keys/default_operator_key.pem` |

Para compilar con otros valores, se crea `firmware/build_opt.h` (ignorado por git) con una opción por línea, por ejemplo `-DJ5_NETWORK_KEY="\"otra clave\""`. El core de ESP32 pasa ese archivo a cada compilación, también desde el IDE de Arduino. El evento `boot` indica con `key` si el nodo usa la clave de red por defecto y con `operator_key`, si usa la clave del operador por defecto.

## Recepción

Un nodo revisa cada paquete en este orden. Ante la primera condición que no se cumple, lo descarta y emite el evento que se indica (ver [consola](console.md)):

1. CRC correcto; si no, `drop` con motivo `crc`.
2. Al menos 16 bytes; si no, `drop` con motivo `short`.
3. Etiqueta válida; si no, `drop` con motivo `tag`.
4. Tipo conocido; si no, `drop` con motivo `type`.
5. Cuerpo con un largo válido para el tipo; si no, `drop` con motivo `body`.
6. Origen distinto del propio; si no, `id_conflict`.
7. Paquete nuevo; si no, `duplicate`.
8. Destino propio o `FFFF`; si no, se ignora sin emitir nada.

Para decidir si un paquete es nuevo, cada nodo guarda por origen la época y la secuencia del último paquete aceptado. Un paquete es nuevo si su origen no figura, si su época es distinta de la guardada o si, con la misma época, su secuencia es posterior en aritmética módulo 2¹⁶. La tabla admite 16 orígenes; cuando se llena, se reemplaza el que hace más tiempo que no se escucha.

Ningún nodo retransmite paquetes ajenos. La retransmisión llega con la malla (ver [trabajo futuro](../future-work.md)).


## Tipos de mensaje

| Tipo | Nombre | Destino | Cuerpo |
|---|---|---|---|
| `0x01` | `HELLO` | `FFFF` | Presencia del nodo |
| `0x02` | `ECHO_REQUEST` | Un nodo | Pedido de eco |
| `0x03` | `ECHO_REPLY` | El nodo que pidió el eco | Respuesta de eco |
| `0x10` | `TEST` | `FFFF` | Paquete de una corrida |
| `0x20` | `FRAGMENT` | `FFFF` | Fragmento de una imagen |
| `0x21` | `REPORT` | El nodo que envió el último fragmento | Fragmentos faltantes de una imagen |

### HELLO

| Campo | Bytes | Descripción |
|---|---|---|
| `model` | 1 | Modelo de placa: `1` es V2 y `2` es V4.3 |
| `version` | 4 | Versión activa; `0` es el programa de fábrica |
| `available` | 4 | Versión disponible: la mayor cuya imagen completa y verificada tiene el nodo, o la activa si no tiene una mayor |
| `vm` | 1 | Estado de la VM (ver abajo) |
| `transmitted` | 4 | Paquetes transmitidos desde el arranque |
| `neighbor_count` | 1 | Cantidad de vecinos que siguen, hasta 16 |
| `id` | 2 | Por cada vecino: su identificador |
| `rssi` | 1 | Por cada vecino: RSSI de su último paquete, en dBm enteros y con el signo cambiado |
| `snr` | 1 | Por cada vecino: SNR de su último paquete, en cuartos de dB y con signo |

El cuerpo ocupa 15 bytes más 4 por vecino. El byte `vm` resume las fallas de la versión activa desde que se activó ([ADR 0011](../adrs/0011-implicit-activation-without-rollback.md)):

| Bits | Descripción |
|---|---|
| 0 a 2 | Motivo de la última falla: `0` ninguna, `1` `division_by_zero`, `2` `instruction_limit`, `3` `end_of_program`, `4` `invalid_opcode`, `5` `invalid_register` y `6` `truncated_instruction` ([la VM](virtual-machine.md)) |
| 3 | `1` si el último tick terminó en falla |
| 4 a 7 | Reservados, en `0` |

Cada nodo emite un HELLO cada 10 s, con una variación aleatoria de ±20 %, y otro apenas cambia su versión activa o su versión disponible. Durante una corrida lo suspenden tanto el emisor como los receptores. Mientras dura una ráfaga, el nodo que la manda y el que la recibe postergan el HELLO periódico hasta que termina; el HELLO por un cambio de versión no se posterga. Un vecino sale de la tabla si pasan 60 s sin recibir ningún paquete suyo, de cualquier tipo.

### ECHO_REQUEST y ECHO_REPLY

El pedido lleva el número de eco `n` (2 bytes) y se completa con ceros hasta el largo pedido, de 4 a 239 bytes. El destino responde enseguida con un cuerpo del mismo largo, así los dos sentidos ocupan el mismo tiempo de aire. Cada nodo responde con su propia potencia de transmisión.

| Campo de la respuesta | Bytes | Descripción |
|---|---|---|
| `n` | 2 | El número del pedido |
| `rssi` | 1 | RSSI con que se recibió el pedido, en dBm enteros y con el signo cambiado |
| `snr` | 1 | SNR con que se recibió el pedido, en cuartos de dB y con signo |
| relleno | resto | Ceros hasta el largo del pedido |

### TEST

| Campo | Bytes | Descripción |
|---|---|---|
| `run` | 2 | Número de la corrida, propio del emisor |
| `index` | 2 | Posición del paquete en la corrida, desde 0 |
| `count` | 2 | Cantidad de paquetes de la corrida |
| `interval` | 2 | Milisegundos entre el fin de un paquete y el comienzo del siguiente |
| relleno | resto | Ceros hasta el largo pedido, de 8 a 239 bytes |

### FRAGMENT

Cada fragmento lleva una parte de una [imagen](image.md) y alcanza para ubicarla sin ningún intercambio previo ([ADR 0009](../adrs/0009-self-describing-fragments.md)).

| Campo | Bytes | Descripción |
|---|---|---|
| `version` | 4 | Versión de la imagen |
| `index` | 1 | Índice del fragmento dentro de la imagen, desde 0 |
| `count` | 1 | Cantidad de fragmentos de la imagen con este tamaño |
| `size` | 1 | Tamaño del fragmento, de 32 a 231 bytes |
| `remaining` | 1 | Fragmentos que le quedan a la ráfaga después de este |
| `data` | resto | Los bytes de la imagen desde `index × size` |

`data` ocupa `size` bytes en todos los fragmentos salvo el último (`index = count − 1`), que lleva el resto de la imagen, de 1 a `size` bytes. Con el último fragmento, el receptor conoce el largo exacto: `(count − 1) × size` más el largo de su `data`. El cuerpo es inválido si `version` es 0, si `size` está fuera de rango, si `index` no es menor que `count`, si `remaining` no es menor que `count`, si `count × size` no alcanza para 74 bytes o si `(count − 1) × size` llega a 1097, si el largo de `data` no corresponde a la posición o si el último fragmento llevaría la imagen más allá de 1097 bytes, es decir, si `(count − 1) × size` más el largo de su `data` supera 1097.

### REPORT

| Campo | Bytes | Descripción |
|---|---|---|
| `version` | 4 | Versión de la imagen |
| `size` | 1 | Tamaño del fragmento con que se cuentan los faltantes, de 32 a 231 bytes |
| `count` | 1 | Cantidad de fragmentos de la imagen con ese tamaño, de 1 a 35 |
| `missing` | `⌈count / 8⌉` | Mapa de bits de los fragmentos faltantes: el fragmento `i` es el bit `i mod 8` (el menos significativo primero) del byte `⌊i / 8⌋`; los bits que sobran van en `0` |

El cuerpo es inválido si `version` es 0, si `size` o `count` están fuera de rango o si su largo no es `6 + ⌈count / 8⌉`.

## Transferencia de imágenes

Las reglas de esta sección implementan las [ADR 0010](../adrs/0010-receiver-driven-repair.md) y [0011](../adrs/0011-implicit-activation-without-rollback.md). Las imágenes viven solo en RAM: un nodo que se reinicia vuelve a la versión 0, sin imagen disponible.

### Imágenes que guarda un nodo

- El programa de la versión activa, dentro de la VM.
- La imagen de la versión disponible, si es mayor que la activa o si es la activa misma. Es la única que el nodo envía.
- Una recepción en curso, solo de una versión mayor que la disponible.

Un fragmento de una versión no mayor que la disponible se ignora. Si llega un fragmento de una versión mayor que la de la recepción en curso, el nodo la abandona y empieza la nueva; uno de una versión menor se ignora. El receptor anota qué bytes de la imagen ya tiene, no qué fragmentos, así que puede completar una imagen con fragmentos de tamaños distintos. Si un fragmento contradice el largo de la imagen que ya conoce, el nodo descarta la recepción y la vuelve a empezar con ese fragmento.

Al completar los bytes, el nodo verifica la imagen ([imagen](image.md)); una imagen cuya cabecera trae una versión distinta de la de sus fragmentos se rechaza por formato. Si no pasa la verificación, la descarta entera y vuelve a esperar la versión. Si la pasa, la imagen pasa a ser la disponible y reemplaza a la anterior.

### Ráfagas

El nodo manda la imagen disponible completa en una ráfaga a `FFFF`, con el tamaño de fragmento de su parámetro de consola (231 bytes por defecto), en estos casos:

- cuando el operador la carga por la consola;
- una vez, sin condiciones, cuando la completa por la radio;
- cuando el HELLO de un vecino anuncia una versión disponible menor que la propia, salvo que ya tenga en curso o en espera una ráfaga de esa versión.

Los fragmentos salen uno detrás de otro, en orden de índice, y cada uno en un paquete nuevo, con secuencia nueva. Si llega un reporte mientras la ráfaga está en curso o en espera, sus fragmentos se suman a ella.

### Reportes

El receptor calcula cuándo termina la ráfaga con cada fragmento que recibe: el instante en que lo recibió más `remaining` veces el tiempo de aire de un fragmento completo, más 500 ms. Si al llegar el fragmento con `remaining = 0`, o al vencer ese plazo, a la recepción le faltan bytes, manda un reporte al nodo que le envió el último fragmento. El reporte usa el tamaño y la cantidad de ese fragmento y marca como faltante todo fragmento al que le falte algún byte; mientras el largo exacto no se conoce, el último fragmento cuenta como faltante.

El nodo que recibe un reporte de su versión disponible responde con los fragmentos marcados, del tamaño que indica el reporte, en una ráfaga a `FFFF`. Un reporte de cualquier otra versión se ignora. El nodo que envía no guarda estado por receptor.

Si después de un reporte no llega ningún fragmento de esa versión en un plazo igual al tiempo de aire del reporte más el de un fragmento completo, más 500 ms, el receptor repite el reporte. No hay un límite de rondas: el receptor deja de reportar cuando el nodo que envía sale de su tabla de vecinos y retoma cuando vuelve a escucharlo. Si el nodo que envía no vuelve, la recepción espera la ráfaga que dispara el HELLO propio en otro vecino.

### Activación

Un nodo activa su versión disponible v, si es mayor que la activa, en estos casos:

- cuando escucha un HELLO que anuncia v como versión activa;
- cuando completa la imagen de v y algún vecino de su tabla ya anuncia v como versión activa;
- cuando el operador lo ordena por la consola con `activate`.

Activar carga el programa en la VM, corta el tick en curso, vuelve a contar los ticks desde 1, ejecuta el primer tick enseguida y pone en 0 el byte `vm` del HELLO; los registros no cambian. La causa no importa: es igual con la consola, con un HELLO o con la tabla de vecinos. El nodo nunca vuelve por su cuenta a una versión anterior.

### Suspensión

Mientras los HELLO están suspendidos, por una corrida o por `presence off` ([ADR 0007](../adrs/0007-operator-hello-hold-with-expiry.md)), el nodo no manda fragmentos ni reportes, pero sigue recibiendo fragmentos. Al terminar la suspensión retoma las ráfagas pendientes y los reportes.
