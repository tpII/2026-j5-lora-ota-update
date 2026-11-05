# Firmware del nodo

Sketch de Arduino común a las placas Heltec WiFi LoRa 32 V2 y V4.3 ([ADR 0001](../docs/adrs/0001-mixed-heltec-v2-and-v4-3-boards.md)). Implementa la trama autenticada, la presencia, el eco, las corridas de prueba, la verificación y la transferencia de imágenes firmadas, la activación de programas en la VM, la consola por serie y por WiFi y el texto de depuración en el OLED. Los contratos que cumple están en [`docs/protocol/`](../docs/protocol/).

## Compilación

### Con arduino-cli

`sketch.yaml` define un perfil por modelo, con el core, las bibliotecas y las opciones de placa fijados:

```sh
arduino-cli compile --profile heltec_v2 firmware
arduino-cli compile --profile heltec_v4_3 firmware
arduino-cli upload --profile heltec_v4_3 --port /dev/ttyACM0 firmware
```

La primera compilación con un perfil descarga sus propias copias del core esp32 3.3.12 y de las bibliotecas ArduinoJson 7.4.3, RadioLib 7.8.1, SimpleCLI 1.1.4 y U8g2 2.36.19.

### Con el IDE de Arduino

El IDE 2.3 no lee los perfiles. Hay que instalar a mano el core esp32 3.3.12 y las bibliotecas ArduinoJson 7.4.3, RadioLib 7.8.1, SimpleCLI 1.1.4 y U8g2 2.36.19, y elegir la placa y las opciones del menú Tools:

| Opción | V2 | V4.3 |
|---|---|---|
| Placa | Heltec WiFi LoRa 32(V2) | Heltec WiFi LoRa 32(V4) |
| USB CDC On Boot | no aplica | Enabled |
| USB Mode | no aplica | Hardware CDC and JTAG |
| Flash Size | no aplica | 16MB (128Mb) |
| Partition Scheme | no aplica | 16M Flash (3MB APP/9.9MB FATFS) |
| Events Run On | no aplica | Core 0 |

Sin «USB CDC On Boot», la consola de la V4.3 sale por los pines 43 y 44 en lugar del puerto USB.

La consola funciona a 921600 baudios. En el monitor serie hay que elegir esa velocidad y «New Line» como fin de línea.

## Claves

La clave de red del HMAC, la contraseña del punto de acceso y la clave pública del operador se compilan en el firmware. Las dos primeras valen `bichofeo` por defecto. La clave pública del operador es, por defecto, la del par de desarrollo cuya clave privada está en `keys/default_operator_key.pem` ([ADR 0012](../docs/adrs/0012-image-format-and-operator-key.md)). Para usar otros valores, se crea `firmware/build_opt.h`, que git ignora, con una opción por línea:

```
-DJ5_NETWORK_KEY="\"otra clave\""
-DJ5_ACCESS_POINT_PASSWORD="\"otra contraseña\""
-DJ5_OPERATOR_PUBLIC_KEY="\"<64 dígitos hexadecimales>\""
```

El core de ESP32 pasa ese archivo a cada compilación, también desde el IDE. WPA2 exige una contraseña de al menos 8 caracteres. Todos los nodos de una red tienen que compartir la clave de red y la clave pública del operador. La compilación falla si `J5_OPERATOR_PUBLIC_KEY` no tiene 64 caracteres; si no es hexadecimal, el nodo lo avisa al arrancar y rechaza todas las imágenes. El evento `boot` indica con `key` y `operator_key` si el nodo usa los valores por defecto. Cómo generar un par nuevo está en [la imagen](../docs/protocol/image.md).

Con el par por defecto, cualquiera que tenga el repositorio puede firmar una imagen válida: solo sirve para el banco.

## Estructura

`firmware.ino` es el punto de entrada: crea la aplicación y la atiende desde `loop()`. El resto del código está en `src/`, agrupado por responsabilidad. El IDE de Arduino compila `src/` con todas sus subcarpetas.

| Carpeta | Archivos | Responsabilidad |
|---|---|---|
| `src/` | `configuration.h` | Constantes del firmware y claves compiladas |
| `src/application/` | `node_application` | Bucle principal, comandos de consola (con SimpleCLI) y emisión de eventos |
| `src/board/` | `board_support` | Modelo de placa, alimentación, etapa de RF de la V4.3 y traducción de la potencia |
| `src/radio/` | `radio_link` | Transceptor LoRa: parámetros en caliente, transmisión y recepción con marcas de tiempo |
| | `radio_settings` | Parámetros de radio, valores por defecto y validación del comando `radio` |
| | `time_on_air` | Fórmula de Semtech del tiempo de aire |
| `src/network/` | `frame` | Formato de la trama y etiqueta HMAC-SHA256 |
| | `node_identity` | Identificador, época y secuencia |
| | `duplicate_filter` | Descarte de repetidos por origen, época y secuencia |
| | `neighbor_table` | Tabla de vecinos |
| | `byte_order.h`, `link_quality.h` | Codificación de enteros, RSSI y SNR en los cuerpos |
| `src/services/` | `presence_service` | Calendario y cuerpo del HELLO, y su suspensión a pedido del operador |
| | `echo_service` | Pedido de eco pendiente y cuerpos del eco |
| | `test_run_service` | Corridas del emisor y estadísticas del receptor |
| | `transfer_service` | Transferencia de imágenes: imagen disponible, recepción, ráfagas, reportes, pedidos de activación y sus eventos |
| `src/image/` | `image_format.h` | Formato de la imagen: cabecera, programa y firma, con sus largos |
| | `image_verifier` | Verificación de una imagen completa: formato, firma Ed25519 con libsodium y validación del programa |
| `src/transfer/` | `transfer_messages` | Cuerpos de FRAGMENT y REPORT, con sus reglas de validez y el mapa de bits del reporte |
| | `image_reception` | Recepción en curso: bytes recibidos, cotas del largo, armado del reporte y plazos de fin de ráfaga y de repetición del reporte |
| | `burst_scheduler` | Ráfagas de la imagen disponible: la que está en curso y las que esperan, fragmentos de a uno y suma de los reportes |
| `src/console/` | `console`, `event_fields` | Consola, eventos JSON (con ArduinoJson) y formato de sus campos |
| | `serial_transport`, `wireless_transport`, `console_line_limit.h` | Transportes de la consola: serie y WebSocket sobre el punto de acceso, y largo máximo de cada línea |
| `src/display/` | `debug_display` | OLED: fila de estado y registro de depuración |
| `src/vm/` | `virtual_machine` | Micro VM de registros: carga y validación del programa, ticks, fallas y estado que anuncia el HELLO |

Cada módulo es un par `.h` y `.cpp` con el mismo nombre, salvo los que son solo un encabezado. Los `#include` entre carpetas usan rutas relativas.

Todo corre en el bucle principal. La única tarea que se suma a las del core es la del servidor HTTP de ESP-IDF, que solo mueve líneas de consola ([ADR 0003](../docs/adrs/0003-control-panel-as-pwa-over-websocket.md)).

## Transferencia de imágenes

Las reglas están en [la trama](../docs/protocol/frame.md) y en las ADR [0009](../docs/adrs/0009-self-describing-fragments.md) a [0012](../docs/adrs/0012-image-format-and-operator-key.md). Las imágenes viven solo en RAM: al reiniciarse, el nodo vuelve a la versión 0, sin imagen disponible. `TransferService` guarda la imagen disponible, una recepción en curso y hasta `BURST_QUEUE_CAPACITY` ráfagas. Los fragmentos y los reportes salen de a uno, cuando la cola de transmisión está vacía, así que una ráfaga nunca demora a `loop()` ni a una respuesta de eco. Mientras el nodo manda o recibe una ráfaga, el HELLO periódico espera y el OLED no se redibuja; el HELLO por un cambio de versión sale igual. Mientras los HELLO están suspendidos, no salen fragmentos ni reportes.

`TransferService` emite sus propios eventos y le pide a `NodeApplication` las activaciones y el HELLO inmediato. La verificación Ed25519 de una imagen completa corre en el bucle principal; su duración en las placas todavía no se midió.

La imagen disponible, la recepción, la imagen que llega por la consola y el búfer de los eventos, que tiene que admitir el evento `program`, suman unos 6,5 KB de RAM. libsodium agrega unos 70 KB de flash.

## Editor

Para que clangd (Zed, VS Code o Neovim) entienda el firmware, se genera `firmware/.clangd` desde la raíz del repositorio:

```sh
tools/generate_clangd_configuration.py              # perfil heltec_v4_3
tools/generate_clangd_configuration.py heltec_v2
```

El script pide a arduino-cli la base de compilación del perfil, expande sus opciones y escribe en `.clangd` las definiciones y los directorios de encabezados, incluidos los del compilador de Xtensa. El archivo tiene rutas de cada computadora, así que git lo ignora; hay que volver a generarlo al cambiar de perfil, de core o de bibliotecas. Con el perfil de una placa, el editor muestra como inactivo el código del otro modelo. `.zed/settings.json` hace que Zed trate `firmware.ino` como C++.

## Pruebas

`tests/run_host_tests.sh` compila y ejecuta en la computadora las pruebas de los módulos que no dependen del hardware: la fórmula del tiempo de aire, el descarte de repetidos, los cuerpos de los mensajes (HELLO, FRAGMENT y REPORT incluidos), el armado de los campos de los eventos, la VM, el largo máximo de las líneas de consola, la verificación de imágenes, la recepción por bytes y las ráfagas. La verificación se prueba con un vector firmado con OpenSSL y el par por defecto. El script toma ArduinoJson de la copia que descarga la primera compilación con un perfil y enlaza la libsodium del sistema (paquete `libsodium` en Arch o `libsodium-dev` en Debian). La radio, los transportes, el OLED y `TransferService` se prueban sobre las placas.

## Notas de hardware

- La V4.3 maneja su etapa de RF KCT8103L con GPIO7 (alimentación), GPIO2 (habilitación), GPIO5 (transmisión o LNA puenteado) y el DIO2 del SX1262. Al arrancar, el firmware verifica que la etapa responda como KCT8103L y lo avisa por la consola si no.
- La polaridad de Vext en la V4.3 no está confirmada: el esquemático indica que se enciende en bajo. Si el OLED queda apagado, hay que cambiar `EXTERNAL_POWER_ON_LEVEL` en `src/board/board_support.cpp`.
- En la V2, Vext alimenta también el conmutador de RF, así que la radio no funciona con Vext apagado.
- Nunca transmitir sin la antena conectada.
