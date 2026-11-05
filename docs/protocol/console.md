# Consola

Contrato entre el firmware y el panel de control, versión 2. La consola es la misma en los dos transportes:

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
| `protocol` | Versión del protocolo de la trama, hoy `2` |
| `key` | `"default"` si usa la clave de red por defecto; `"custom"` si no |
| `operator_key` | `"default"` si usa la clave pública del operador por defecto ([imagen](image.md)); `"custom"` si no |

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

### `presence`

Con el comando `presence`, con `status` y cuando vence la suspensión de los HELLO.

| Campo | Descripción |
|---|---|
| `state` | `"on"` si el nodo envía sus HELLO; `"off"` mientras el operador los suspende |
| `remaining` | Segundos que faltan para que la suspensión venza y los HELLO vuelvan solos; `null` con `"on"` |

### `status`

Con el comando `status`. Lo siguen un `radio`, un `wifi`, un `presence`, un `vm`, un `transfer` y un `neighbor` por cada vecino.

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
| `version` | Versión activa del vecino |
| `available` | Versión disponible del vecino |
| `vm_fault` | Motivo de la última falla de la VM del vecino desde su activación, con los nombres de `vm_fault`, o `null` si no hubo ninguna |
| `vm_failing` | `true` si el último tick del vecino terminó en falla |
| `tx` | Paquetes transmitidos por el vecino, según su último HELLO |
| `rssi`, `snr` | Calidad del último paquete recibido del vecino |
| `age` | Milisegundos desde el último paquete recibido del vecino |

### `tx`

Al terminar cada transmisión.

| Campo | Descripción |
|---|---|
| `type` | `"hello"`, `"echo_request"`, `"echo_reply"`, `"test"`, `"fragment"` o `"report"` |
| `dst` | Destino de la trama |
| `seq` | Secuencia de la trama |
| `size` | Largo de la trama completa en bytes |
| `toa` | Tiempo de aire medido, desde que la radio empieza a transmitir hasta la interrupción de fin |
| `toa_calc` | Tiempo de aire según la fórmula de Semtech |
| `run` | Solo en `"test"`: corrida |
| `index` | Solo en `"test"` y `"fragment"`: posición del paquete en la corrida o índice del fragmento en la imagen |
| `version` | Solo en `"fragment"` y `"report"`: versión de la imagen |

### `hello`

Al recibir un HELLO.

| Campo | Descripción |
|---|---|
| `src` | Identificador del emisor |
| `epoch`, `seq` | Época y secuencia de la trama |
| `model` | Modelo de placa del emisor |
| `version` | Versión activa del emisor |
| `available` | Versión disponible del emisor |
| `vm_fault`, `vm_failing` | Estado de la VM del emisor, como en `neighbor` |
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

### `vm`

Con `status`, `load_registers` y cada activación. La VM está descripta en [la VM](virtual-machine.md).

| Campo | Descripción |
|---|---|
| `version` | Versión activa; `0` es el programa de fábrica, que está vacío |
| `size` | Largo del programa en bytes |
| `tick` | Ticks del programa activo hasta ahora |
| `registers` | Arreglo con R1 a R4, como enteros de 32 bits con signo |

### `vm_print`

Con cada instrucción `PRINT`. El nodo escribe además `VM: Rn - 0x00000000` como texto de depuración, que es lo que muestra el OLED.

| Campo | Descripción |
|---|---|
| `tick` | Tick en curso |
| `reg` | Registro, de 1 a 4 |
| `value` | Valor del registro, como entero de 32 bits con signo |

### `vm_fault`

Cuando una falla termina un tick.

| Campo | Descripción |
|---|---|
| `tick` | Tick que terminó |
| `pc` | Dirección de la instrucción que falló |
| `reason` | `"division_by_zero"`, `"instruction_limit"`, `"end_of_program"`, `"invalid_opcode"`, `"invalid_register"` o `"truncated_instruction"` |

### `transfer`

Con `status` y con el comando `fragment_size`.

| Campo | Descripción |
|---|---|
| `active` | Versión activa |
| `available` | Versión disponible |
| `receiving` | Versión de la recepción en curso, o `null` |
| `missing` | Bytes que le faltan a la recepción en curso, o `null`; mientras no se conoce el largo exacto, se cuentan hasta el final del último fragmento |
| `fragment_size` | Tamaño de fragmento de las ráfagas completas del nodo, en bytes |

### `image`

Cuando una imagen nueva pasa a ser la versión disponible ([trama](frame.md)).

| Campo | Descripción |
|---|---|
| `version` | Versión de la imagen |
| `size` | Largo del programa en bytes |
| `image_size` | Largo de la imagen completa en bytes |
| `via` | `"console"` si la cargó el operador; `"radio"` si llegó en fragmentos |
| `src` | Nodo que envió el último fragmento, o `null` con `"console"` |
| `fragments` | Fragmentos de esa versión aceptados durante la recepción, repetidos incluidos; `0` con `"console"` |
| `reports` | Reportes enviados durante la recepción; `0` con `"console"` |
| `duration` | Milisegundos desde el primer fragmento de la recepción hasta completarla; `0` con `"console"` |

### `image_rejected`

Cuando una imagen recibida por la radio no pasa la verificación y se descarta. Las imágenes rechazadas por la consola responden `error`.

| Campo | Descripción |
|---|---|
| `version` | Versión de la imagen |
| `reason` | `"format"`, `"signature"` o `"program"` ([imagen](image.md)) |
| `src` | Nodo que envió el último fragmento |

### `fragment_rx`

Al recibir un fragmento, se use o no.

| Campo | Descripción |
|---|---|
| `src` | Nodo que envió el fragmento |
| `version`, `index`, `count`, `size`, `remaining` | Los campos del fragmento |
| `accepted` | `true` si el fragmento pertenece a la recepción en curso; `false` si se ignoró por su versión |
| `new` | `true` si aportó algún byte que faltaba |
| `rssi`, `snr` | Calidad del fragmento |

### `burst_start` y `burst_done`

En el nodo que envía, al empezar y al terminar una ráfaga.

| Campo | Evento | Descripción |
|---|---|---|
| `version` | ambos | Versión de la imagen |
| `size` | ambos | Tamaño del fragmento |
| `count` | `burst_start` | Fragmentos de la ráfaga al empezar; un reporte puede sumar más |
| `cause` | `burst_start` | `"load"` (carga por la consola), `"complete"` (imagen completada por la radio), `"hello"` (HELLO de un vecino con una versión disponible menor) o `"report"` |
| `trigger` | `burst_start` | Con `"hello"` y `"report"`: el nodo que la disparó; si no, `null` |
| `sent` | `burst_done` | Fragmentos transmitidos; puede quedar debajo de `count` si una imagen nueva reemplaza a la disponible en medio de la ráfaga, que entonces se corta |
| `duration` | `burst_done` | Microsegundos desde el comienzo del primer fragmento hasta el fin del último |

### `report_sent` y `report_received`

Al enviar un reporte y al recibir uno dirigido al nodo.

| Campo | Evento | Descripción |
|---|---|---|
| `dst` | `report_sent` | Nodo al que va el reporte |
| `src` | `report_received` | Nodo que reporta |
| `version`, `size`, `count` | ambos | Los campos del reporte |
| `missing` | ambos | Arreglo con los índices de los fragmentos faltantes |
| `round` | `report_sent` | Número de reporte dentro de la recepción, desde 1 |

### `activation`

Cuando cambia la versión activa. Lo sigue un `vm`.

| Campo | Descripción |
|---|---|
| `version` | Versión activada |
| `previous` | Versión activa anterior |
| `cause` | `"console"` (comando `activate`), `"hello"` (HELLO que la anuncia como activa) o `"neighbor"` (un vecino de la tabla ya la tenía activa al completar la imagen) |
| `src` | Con `"hello"` y `"neighbor"`: el vecino que la anunció; si no, `null` |

### `program`

Con el comando `program`.

| Campo | Descripción |
|---|---|
| `version` | Versión activa |
| `size` | Largo del programa en bytes |
| `code` | El programa, con dos dígitos hexadecimales en minúscula por byte; vacío con la versión 0 |

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
| `not_available` | La versión de `activate` no es la disponible |
| `radio_failure` | La radio rechazó la operación; ver `code` |
| `wifi_failure` | No se pudo encender el punto de acceso |
| `line_too_long` | La línea supera los 200 caracteres, o el largo de una imagen completa en `load_image` |
| `version_not_newer` | La versión de `load_image` no es mayor que la disponible, o la de `activate` no es mayor que la activa |
| `invalid_image` | La imagen de `load_image` no es hexadecimal o no pasa la verificación ([imagen](image.md)); `detail` empieza con `format`, `signature` o `program` y lo explica |

## Comandos

Una línea de texto con palabras separadas por espacios, en minúscula. En el monitor serie del IDE de Arduino hay que elegir «New Line» como fin de línea.

| Comando | Qué hace |
|---|---|
| `help` | Lista los comandos como texto de depuración |
| `status` | Emite `status`, `radio`, `wifi`, `presence`, `vm`, `transfer` y un `neighbor` por vecino |
| `radio` | Emite `radio` con los parámetros actuales |
| `radio <clave> <valor> [<clave> <valor> ...]` | Cambia uno o más parámetros de radio a la vez; si alguno es inválido, no cambia ninguno. Claves en [radio](radio.md) |
| `radio reset` | Vuelve a los parámetros por defecto |
| `echo <id> [largo]` | Pide un eco al nodo `id` con un cuerpo de `largo` bytes, de 4 a 239; por defecto, 16. Uno por vez |
| `run <cantidad> <largo> <intervalo>` | Transmite una corrida de `cantidad` paquetes TEST (1 a 65535) con un cuerpo de `largo` bytes (8 a 239), separados por `intervalo` milisegundos (0 a 60000). Con intervalo 0, los paquetes salen seguidos |
| `run stop` | Detiene la corrida en curso |
| `wifi on`, `wifi off` | Enciende o apaga el punto de acceso |
| `resend` | Vuelve a transmitir tal cual la última trama propia, para verificar el descarte de repetidos |
| `presence off <segundos>` | Suspende los HELLO del nodo durante `segundos` como máximo (1 a 3600). Al vencer el plazo vuelven solos y el nodo emite `presence` |
| `presence on` | Reanuda los HELLO; el primero sale entre 1 y 3 s después, como al arrancar |
| `load_registers <r1> <r2> <r3> <r4>` | Asigna los cuatro registros de la VM. Cada valor va en decimal o en hexadecimal con `0x`, de −2147483648 a 4294967295; por encima de 2147483647 se guarda el patrón de bits. Emite `vm` |
| `load_image <imagen>` | Carga una imagen firmada ([imagen](image.md)), con dos dígitos hexadecimales por byte. Su versión tiene que ser mayor que la disponible. El nodo revisa primero el formato, después la versión y por último la firma y el programa, así que una imagen mal formada responde `invalid_image` aunque su versión no sea mayor. Si pasa la verificación, pasa a ser la versión disponible: emite `image`, un HELLO y la ráfaga completa. No la activa |
| `activate <versión>` | Activa la versión disponible, que tiene que ser `versión` y mayor que la activa. Emite `activation`, `vm` y un HELLO, y ejecuta el primer tick enseguida |
| `fragment_size [<bytes>]` | Sin argumento, emite `transfer`. Con argumento, fija el tamaño de fragmento de las ráfagas completas siguientes, de 32 a 231 bytes, y emite `transfer`. Al arrancar vale 231 |
| `program` | Emite `program` con el programa activo, para volver a firmarlo con otra versión |

Las líneas tienen como máximo 200 caracteres, salvo `load_image`, que admite una imagen completa: 2226 caracteres con la imagen de 1097 bytes. El evento `program` puede superar los 200 caracteres.

Durante una corrida, `radio` con argumentos, `echo` y `resend` responden `error` con motivo `busy`. `load_image` y `activate` se aceptan, pero la ráfaga y el HELLO esperan a que termine la suspensión de los HELLO.

Mientras los HELLO están suspendidos, el OLED tampoco se redibuja, para que sus bloqueos de unos 30 ms no demoren las respuestas de eco. Una corrida suspende los HELLO por su cuenta; al terminar, los reanuda solo si el operador no los había suspendido.

## Métricas que salen de los eventos

| Medida | Cómo se obtiene |
|---|---|
| Tiempo de aire | `toa` de cada `tx`, contra `toa_calc` |
| PDR de una corrida | `received / count` de `run_end` |
| *Goodput* de una corrida | `received × size × 8 / duration`, con `received` de `run_end` en el receptor y `duration` de `run_done` en el emisor, en bits por segundo |
| M1, tiempo de convergencia | En el panel, desde que envía `load_image` hasta que todos los nodos del grafo de conexiones anuncian la versión como activa. Como la activación la ordena el operador ([ADR 0011](../adrs/0011-implicit-activation-without-rollback.md)), se informa además separado en distribución (hasta que todos la anuncian como disponible) y activación (desde que el panel envía `activate`) |
| M2, eficiencia de la inundación | Paquetes transmitidos por todos los nodos durante la actualización, según la diferencia de `tx` de sus HELLO, dividido el mínimo teórico: fragmentos de la imagen por cantidad de nodos menos uno. Los `tx` de tipo `"fragment"` y `"report"` dan además la parte que corresponde a la transferencia |
| M3, pérdida y reparación | Por receptor: el porcentaje de fragmentos marcados en su primer reporte (`report_sent` con `round` 1, o `report_received`) y la cantidad de rondas de reparación, `reports` de su `image`. Un receptor cuyo `image` trae `reports` en 0 no perdió ningún fragmento |
| M4, latencia de ida y vuelta | `rtt` de cada `echo`; cada `echo_lost` cuenta como pérdida |
| M6, calidad de enlace | `rssi` y `snr` de `hello`, `test_rx` y `echo` |
| Prueba de comunicación | Con cada `echo`: `remote_rssi` y `remote_snr` para la ida, `rssi` y `snr` para la vuelta y `rtt`. Los bits útiles son `size × 8` por sentido de cada eco respondido; la tasa de bits útiles los divide por la suma de los `rtt` |
