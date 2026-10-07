# Trama LoRa

Contrato entre nodos, versión 1 del protocolo. Los campos de más de un byte van en little-endian.

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

`tag` contiene los primeros 8 bytes de HMAC-SHA256(clave de red, versión ‖ cabecera ‖ cuerpo). La versión es un byte con la versión del protocolo (hoy `0x01`) que entra en el cálculo pero no viaja en la trama ([ADR 0005](../adrs/0005-frame-without-hop-count.md)). Un paquete armado con otra versión del protocolo o con otra clave falla la verificación.

## Claves

La clave de red y la contraseña del punto de acceso se compilan en el firmware:

| Macro | Uso | Valor por defecto |
|---|---|---|
| `J5_NETWORK_KEY` | Clave del HMAC | `"bichofeo"` |
| `J5_ACCESS_POINT_PASSWORD` | Contraseña WPA2 del punto de acceso | `"bichofeo"` |

Para compilar con otros valores, se crea `firmware/build_opt.h` (ignorado por git) con una opción por línea, por ejemplo `-DJ5_NETWORK_KEY="\"otra clave\""`. El core de ESP32 pasa ese archivo a cada compilación, también desde el IDE de Arduino. El evento `boot` indica con `key` si el nodo usa la clave por defecto.

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

### HELLO

| Campo | Bytes | Descripción |
|---|---|---|
| `model` | 1 | Modelo de placa: `1` es V2 y `2` es V4.3 |
| `version` | 4 | Versión del programa activo; `0` mientras no haya VM |
| `transmitted` | 4 | Paquetes transmitidos desde el arranque |
| `neighbor_count` | 1 | Cantidad de vecinos que siguen, hasta 16 |
| `id` | 2 | Por cada vecino: su identificador |
| `rssi` | 1 | Por cada vecino: RSSI de su último paquete, en dBm enteros y con el signo cambiado |
| `snr` | 1 | Por cada vecino: SNR de su último paquete, en cuartos de dB y con signo |

Cada nodo emite un HELLO cada 10 s, con una variación aleatoria de ±20 %. Durante una corrida lo suspenden tanto el emisor como los receptores. Un vecino sale de la tabla si pasan 60 s sin recibir ningún paquete suyo, de cualquier tipo.

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
