# Consola

Contrato entre el firmware y el panel de control, versión 1. La consola es la misma en los dos transportes:

- Serie USB a 921600 baudios, 8N1. Cada línea termina en `\n`; el firmware acepta también `\r\n`.
- WebSocket en `ws://192.168.4.1/console`, a través del punto de acceso del nodo ([ADR 0002](../adrs/0002-wifi-access-point-per-node.md) y [ADR 0003](../adrs/0003-control-panel-as-pwa-over-websocket.md)). Cada mensaje de texto lleva una línea, sin el fin de línea.

El nodo escribe cada línea por la serie y por todos los clientes WebSocket conectados, y acepta comandos de cualquiera de ellos. Un cliente WebSocket cuenta como conectado desde su primer mensaje, porque el servidor HTTP de ESP-IDF 5.5.5 no le avisa al firmware cuando termina el handshake; por eso el panel envía `status` apenas abre la conexión. Si el búfer de salida de un transporte está lleno, la línea se descarta en ese transporte y se cuenta en el campo `dropped` de `status`: la consola nunca demora a la radio.

## Líneas que emite el nodo

- Una línea que empieza con `{` es un evento: un objeto JSON en una sola línea.
- Cualquier otra línea es texto de depuración en inglés, para leer desde el monitor serie. Es el mismo texto que muestra el OLED y el panel no lo interpreta.

## Convenciones de los eventos

Todos los eventos tienen estos dos campos:

| Campo | Tipo | Descripción |
|---|---|---|
| `t` | entero | Milisegundos desde el arranque del nodo |
| `ev` | texto | Nombre del evento |

- Los identificadores de nodo van como texto de cuatro dígitos hexadecimales en mayúscula, por ejemplo `"3A7F"`.
- El RSSI va en dBm, redondeado a un decimal, y la SNR en dB, redondeada a dos. Un valor entero se escribe sin decimales, por ejemplo `-35`.
- Las frecuencias van en MHz y los anchos de banda en kHz.
- Las duraciones van en microsegundos, como enteros, salvo que se indique otra unidad.
- `ferr` es el error de frecuencia estimado de un paquete recibido, en Hz.
- `size` es el largo del cuerpo en bytes, salvo en `tx`, donde es el largo de la trama completa.

## Eventos

### `boot`

Al arrancar, después de detectar la placa y configurar la radio. Lo siguen un `radio` y un `wifi`.

| Campo | Descripción |
|---|---|
| `id` | Identificador del nodo |
| `model` | `"V2"` o `"V4.3"` |
| `epoch` | Época actual |
| `firmware` | Versión del firmware, por ejemplo `"0.1.0"` |
| `protocol` | Versión del protocolo de la trama, hoy `1` |
| `key` | `"default"` si usa la clave de red por defecto; `"custom"` si no |

### `radio`

Después del arranque, ante cada cambio de parámetros y con el comando `radio`.

| Campo | Descripción |
|---|---|
| `freq` | Frecuencia central en MHz |
| `sf` | Factor de dispersión |
| `bw` | Ancho de banda en kHz |
| `cr` | Denominador de la tasa de código (5 es 4/5) |
| `preamble` | Largo del preámbulo en símbolos |
| `sync` | Palabra de sincronismo, como entero |
| `power` | Potencia de transmisión en el conector de antena, en dBm |
| `chip` | Ajuste del transceptor que produce esa potencia, en dBm |
| `lna` | `"on"` o `"bypass"` en la V4.3; `null` en la V2 |

### `wifi`

Al arrancar, al encender o apagar el punto de acceso y cuando un cliente se conecta o se desconecta.

| Campo | Descripción |
|---|---|
| `state` | `"on"` u `"off"` |
| `ssid` | Nombre de la red, por ejemplo `"J5-3A7F"` |
| `channel` | Canal WiFi |
| `clients` | Clientes WebSocket conectados |

### `status`

Con el comando `status`. Lo siguen un `radio`, un `wifi` y un `neighbor` por cada vecino.

| Campo | Descripción |
|---|---|
| `id` | Identificador del nodo |
| `model` | Modelo de placa |
| `epoch` | Época actual |
| `tx` | Paquetes transmitidos desde el arranque |
| `rx` | Paquetes válidos recibidos desde el arranque |
| `dropped` | Líneas de consola descartadas por búfer lleno |
| `heap` | Memoria libre en bytes |

### `neighbor`

Uno por cada vecino, después de `status`.

| Campo | Descripción |
|---|---|
| `id` | Identificador del vecino |
| `model` | Modelo de placa del vecino |
| `version` | Versión del programa activo del vecino |
| `tx` | Paquetes transmitidos por el vecino, según su último HELLO |
| `rssi`, `snr` | Calidad del último paquete recibido del vecino |
| `age` | Milisegundos desde el último paquete recibido del vecino |

### `tx`

Al terminar cada transmisión.

| Campo | Descripción |
|---|---|
| `type` | `"hello"`, `"echo_request"`, `"echo_reply"` o `"test"` |
| `dst` | Destino de la trama |
| `seq` | Secuencia de la trama |
| `size` | Largo de la trama completa en bytes |
| `toa` | Tiempo de aire medido, desde que la radio empieza a transmitir hasta la interrupción de fin |
| `toa_calc` | Tiempo de aire según la fórmula de Semtech |
| `run`, `index` | Solo en `"test"`: corrida y posición del paquete |

### `hello`

Al recibir un HELLO.

| Campo | Descripción |
|---|---|
| `src` | Identificador del emisor |
| `epoch`, `seq` | Época y secuencia de la trama |
| `model` | Modelo de placa del emisor |
| `version` | Versión del programa activo del emisor |
| `tx` | Paquetes transmitidos por el emisor desde su arranque |
| `rssi`, `snr`, `ferr` | Calidad del HELLO recibido |
| `neighbors` | Lista de objetos `{ "id", "rssi", "snr" }`: cómo escucha el emisor a cada uno de sus vecinos |

### `echo_served`

Después de responder un pedido de eco.

| Campo | Descripción |
|---|---|
| `src` | Nodo que pidió el eco |
| `n` | Número de eco |
| `size` | Largo del cuerpo |
| `rssi`, `snr` | Calidad con que se recibió el pedido |

### `echo`

Al recibir la respuesta a un eco propio.

| Campo | Descripción |
|---|---|
| `dst` | Nodo que respondió |
| `n` | Número de eco |
| `size` | Largo del cuerpo |
| `rtt` | Microsegundos desde que empezó a transmitirse el pedido hasta que llegó la respuesta |
| `rssi`, `snr` | Calidad con que se recibió la respuesta |
| `remote_rssi`, `remote_snr` | Calidad con que el otro nodo recibió el pedido |

### `echo_lost`

Cuando la respuesta no llega a tiempo. El plazo es el doble del tiempo de aire de la trama más un segundo.

| Campo | Descripción |
|---|---|
| `dst` | Nodo al que se pidió el eco |
| `n` | Número de eco |
| `size` | Largo del cuerpo |
| `timeout` | Plazo en milisegundos |

### `run_start` y `run_done`

En el emisor, al empezar y al terminar una corrida.

| Campo | Evento | Descripción |
|---|---|---|
| `run` | ambos | Número de la corrida |
| `count` | ambos | Paquetes pedidos |
| `size` | `run_start` | Largo del cuerpo de cada paquete |
| `interval` | `run_start` | Milisegundos entre el fin de un paquete y el comienzo del siguiente |
| `sent` | `run_done` | Paquetes efectivamente transmitidos |
| `duration` | `run_done` | Microsegundos desde el comienzo del primer paquete hasta el fin del último |
| `aborted` | `run_done` | `true` si se detuvo con `run stop` |

### `test_rx`

En el receptor, por cada paquete de una corrida.

| Campo | Descripción |
|---|---|
| `src` | Emisor de la corrida |
| `run`, `index`, `count` | Corrida, posición del paquete y cantidad pedida |
| `size` | Largo del cuerpo |
| `rssi`, `snr`, `ferr` | Calidad del paquete |

### `run_end`

En el receptor, al recibir el último paquete de una corrida o cuando vence el plazo sin paquetes nuevos. El plazo es el doble del intervalo más el tiempo de aire de la trama, más un segundo.

| Campo | Descripción |
|---|---|
| `src` | Emisor de la corrida |
| `run`, `count` | Corrida y cantidad pedida |
| `received` | Paquetes recibidos |
| `pdr` | `received / count`, con cuatro decimales |
| `rssi_avg`, `rssi_min`, `rssi_max` | RSSI de los paquetes recibidos |
| `snr_avg` | SNR media |
| `first`, `last` | Valor de `t` del primer y del último paquete recibido |
| `reason` | `"complete"` si llegó el último paquete; `"timeout"` si venció el plazo |

### `duplicate`

Al descartar un paquete repetido.

| Campo | Descripción |
|---|---|
| `src` | Origen del paquete |
| `epoch`, `seq` | Época y secuencia del paquete |
| `type` | Tipo de mensaje, con los mismos nombres que en `tx` |

### `drop`

Al descartar un paquete inválido.

| Campo | Descripción |
|---|---|
| `reason` | `"crc"`, `"short"`, `"tag"`, `"type"` o `"body"` (ver [trama](frame.md)) |
| `size` | Largo recibido en bytes |
| `rssi`, `snr` | Calidad del paquete |

### `id_conflict`

Al recibir un paquete válido cuyo origen es el identificador propio.

| Campo | Descripción |
|---|---|
| `epoch`, `seq` | Época y secuencia del paquete |
| `rssi`, `snr` | Calidad del paquete |

### `error`

Cuando un comando no se puede ejecutar o la radio falla.

| Campo | Descripción |
|---|---|
| `cmd` | Primera palabra del comando, o `"radio"` ante una falla de la radio |
| `reason` | Motivo, según la tabla de abajo |
| `detail` | Opcional: texto con información adicional, por ejemplo el uso correcto |
| `code` | Opcional: código de error de RadioLib |

| Motivo | Significado |
|---|---|
| `unknown_command` | El comando no existe |
| `usage` | Faltan argumentos o sobran |
| `out_of_range` | Un valor está fuera del rango admitido |
| `unreachable_power` | El modelo de placa no puede entregar esa potencia |
| `not_supported` | El parámetro no existe en este modelo, como `lna` en la V2 |
| `busy` | Hay una corrida o un eco en curso |
| `radio_failure` | La radio rechazó la operación; ver `code` |
| `wifi_failure` | No se pudo encender el punto de acceso |
| `line_too_long` | La línea supera los 200 caracteres |

## Comandos

Una línea de texto con palabras separadas por espacios, en minúscula. En el monitor serie del IDE de Arduino hay que elegir «New Line» como fin de línea.

| Comando | Qué hace |
|---|---|
| `help` | Lista los comandos como texto de depuración |
| `status` | Emite `status`, `radio`, `wifi` y un `neighbor` por vecino |
| `radio` | Emite `radio` con los parámetros actuales |
| `radio <clave> <valor> [<clave> <valor> ...]` | Cambia uno o más parámetros de radio a la vez; si alguno es inválido, no cambia ninguno. Claves en [radio](radio.md) |
| `radio reset` | Vuelve a los parámetros por defecto |
| `echo <id> [largo]` | Pide un eco al nodo `id` con un cuerpo de `largo` bytes, de 4 a 239; por defecto, 16. Uno por vez |
| `run <cantidad> <largo> <intervalo>` | Transmite una corrida de `cantidad` paquetes TEST (1 a 65535) con un cuerpo de `largo` bytes (8 a 239), separados por `intervalo` milisegundos (0 a 60000). Con intervalo 0, los paquetes salen seguidos |
| `run stop` | Detiene la corrida en curso |
| `wifi on`, `wifi off` | Enciende o apaga el punto de acceso |
| `resend` | Retransmite tal cual la última trama propia, para verificar el descarte de repetidos |

Durante una corrida, `radio` con argumentos, `echo` y `resend` responden `error` con motivo `busy`.

## Métricas que salen de los eventos

| Medida | Cómo se obtiene |
|---|---|
| Tiempo de aire | `toa` de cada `tx`, contra `toa_calc` |
| PDR de una corrida | `received / count` de `run_end` |
| *Goodput* de una corrida | `received × size × 8 / duration`, con `received` de `run_end` en el receptor y `duration` de `run_done` en el emisor, en bits por segundo |
| M4, latencia de ida y vuelta | `rtt` de cada `echo`; cada `echo_lost` cuenta como pérdida |
| M6, calidad de enlace | `rssi` y `snr` de `hello`, `test_rx` y `echo` |
