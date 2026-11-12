# Firmware del nodo

Sketch de Arduino común a las placas Heltec WiFi LoRa 32 V2 y V4.3 ([ADR 0001](../docs/adrs/0001-mixed-heltec-v2-and-v4-3-boards.md)). Implementa la trama autenticada, la presencia, el eco, las corridas de prueba, la verificación y la transferencia de imágenes firmadas, la activación de programas en la VM, la consola por serie y por WiFi y el texto de depuración en el OLED. Los contratos que cumple están en [`docs/protocol/`](../docs/protocol/).

## Compilación

### Con arduino-cli

`sketch.yaml` define un perfil por modelo, con las versiones del core esp32 y de las bibliotecas (ArduinoJson, RadioLib y U8g2) y las opciones de placa fijadas. Es el único lugar donde están esas versiones:

```sh
arduino-cli compile --profile heltec_v2 firmware
arduino-cli compile --profile heltec_v4_3 firmware
arduino-cli upload --profile heltec_v4_3 --port /dev/ttyACM0 firmware
```

La primera compilación con un perfil descarga sus propias copias del core y de las bibliotecas; `mise run setup:firmware` las descarga para todos los perfiles y `mise run build:firmware` compila todos. Cada perfil es el `buildProfile` de un modelo de placa de `firmware/protocol/contract.json`, y el generador del contrato revisa que coincidan: un modelo nuevo necesita su perfil y su entrada en el contrato. Los scripts leen los perfiles de `sketch.yaml` con `tools/list_build_profiles.mjs`.

### Con el IDE de Arduino

El IDE 2.3 no lee los perfiles. Hay que instalar a mano el core esp32 y las bibliotecas en las versiones que fija `sketch.yaml`, y elegir la placa y las opciones del menú Tools:

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

La clave de red del HMAC, la contraseña del punto de acceso y la clave pública del operador se compilan en el firmware. Las dos primeras valen `bichofeo` por defecto. La clave pública del operador es, por defecto, la del par de desarrollo cuya clave privada está en `firmware/protocol/default_operator_key.pem` ([ADR 0012](../docs/adrs/0012-image-format-and-operator-key.md)). Para usar otros valores, se crea `firmware/build_opt.h`, que git ignora, con una opción por línea:

```
-DJ5_NETWORK_KEY="\"otra clave\""
-DJ5_ACCESS_POINT_PASSWORD="\"otra contraseña\""
-DJ5_OPERATOR_PUBLIC_KEY="\"<64 dígitos hexadecimales>\""
```

El core de ESP32 pasa ese archivo a cada compilación, también desde el IDE. WPA2 exige una contraseña de al menos 8 caracteres. Todos los nodos de una red tienen que compartir la clave de red y la clave pública del operador. La compilación falla si `J5_OPERATOR_PUBLIC_KEY` no tiene 64 caracteres; si no es hexadecimal, el nodo lo avisa al arrancar y rechaza todas las imágenes. El evento `boot` indica con `key` y `operator_key` si el nodo usa los valores por defecto: informa `custom` para toda clave definida en `build_opt.h`, aunque repita el valor por defecto. Cómo generar un par nuevo está en [la imagen](../docs/protocol/image.md).

Con el par por defecto, cualquiera que tenga el repositorio puede firmar una imagen válida: solo sirve para el banco.

## Estructura

`firmware.ino` es el punto de entrada: crea la aplicación y la atiende desde `loop()`. El resto del código está en `src/`, agrupado por responsabilidad. El IDE de Arduino compila `src/` con todas sus subcarpetas.

| Carpeta | Archivos | Responsabilidad |
|---|---|---|
| `src/` | `configuration.h` | Claves compiladas y versión del firmware |
| `src/protocol/` | `protocol_contract.h` | Contrato del protocolo, generado desde `firmware/protocol/contract.json` ([ADR 0013](../docs/adrs/0013-machine-readable-protocol-contract.md)): tamaños, desplazamientos, códigos, rangos, valores por defecto, plazos, tabla de comandos de la consola y vocabularios de los eventos |
| `src/application/` | `node_application` | El hardware del nodo y el bucle principal: una lectura del reloj por pasada, la radio, que mueve tramas entre `NodeServices` y el transceptor, la consola, el WiFi y el OLED |
| | `node_services` | Los servicios que no dependen del hardware, conectados como corren en el nodo, y la política que los cruza: qué trama sale cuando el transmisor está libre, los controles de cada trama recibida y su reparto por tipo, el armado de las tramas con la identidad del nodo, lo que anuncia el HELLO propio y los temporizadores |
| | `console_commands` | Comandos de consola: la función de cada acción de la tabla del contrato, la selección de la forma, las precondiciones, la lectura de argumentos, los errores y `help` |
| | `radio_command` | Comando `radio`: sus formas y la lectura de cada par clave y valor, con el detalle de sus errores |
| | `node_events` | Eventos del nodo que no son de ningún servicio: `boot`, `status`, `radio`, `wifi`, `tx`, `drop`, `duplicate` e `id_conflict` |
| `src/board/` | `board_support.h`, `board_radio.h` | Modelo de placa y lo que cambia de un modelo a otro: alimentación, etapa de RF, transceptor y sus pines, secuencia de arranque, LNA, corrección del RSSI y USB de la consola |
| | `heltec_v2`, `heltec_v4_3` | Implementación de cada modelo; cada archivo se compila solo para su placa |
| `src/radio/` | `radio_link` | Transceptor LoRa: parámetros en caliente, que esperan el fin de la transmisión en curso, transmisión y recepción con marcas de tiempo y resultado de cada operación (`RadioStatus`), sin que RadioLib salga del módulo |
| | `received_frame.h` | Trama recibida, con su RSSI, su SNR, su error de frecuencia y su marca de tiempo |
| | `radio_settings.h` | Parámetros de radio y sus valores por defecto, que salen del contrato |
| | `time_on_air` | Fórmula de Semtech del tiempo de aire |
| `src/network/` | `frame` | Formato de la trama y etiqueta HMAC-SHA256 con libsodium; `SequenceSource`, que numera las tramas del nodo |
| | `node_identity` | Identificador, época guardada en la flash y secuencia |
| | `duplicate_filter` | Descarte de repetidos por origen, época y secuencia |
| | `neighbor_table` | Tabla de vecinos: cada lectura toma la hora y antes descarta los vencidos |
| | `least_recently_heard.h` | Entrada que se reemplaza cuando una tabla de nodos está llena |
| | `transmit_queue` | Cola de transmisión: tramas en espera con su dueño, la trama en el aire con sus tiempos y la última enviada, que repite `resend`; le avisa a cada dueño cómo terminó cada trama suya |
| `src/messages/` | `hello_message` | Cuerpo del HELLO, con el byte `vm` ligado a los códigos de `VmFault` |
| | `echo_message`, `test_message` | Cuerpos de ECHO_REQUEST, ECHO_REPLY y TEST |
| | `fragment_message`, `report_message` | Cuerpos de FRAGMENT y REPORT, con sus reglas de validez, el mapa de bits del reporte y el largo de sus tramas |
| | `message_body` | Decodificación del cuerpo de una trama recibida con el códec de su tipo |
| | `link_quality.h` | RSSI y SNR en los cuerpos |
| `src/timing/` | `millisecond_clock.h` | Comparación de lecturas de `millis()` que admite la vuelta del contador |
| | `transmission_span.h` | Tramas enviadas una tras otra y tiempo desde el inicio de la primera hasta el fin de la última, para las ráfagas y las corridas |
| `src/encoding/` | `hex_codec` | Bytes como dígitos hexadecimales: imágenes, clave del operador y evento `program` |
| | `byte_order.h` | Enteros de varios bytes en orden little-endian |
| `src/services/` | `presence_service` | HELLO propio y de los vecinos: calendario, suspensión durante una corrida o a pedido del operador, reanudación cuando termina la última corrida y eventos `hello`, `neighbor` y `presence`; le pasa el HELLO de cada vecino a la transferencia |
| | `echo_service` | Eco: el pedido pendiente y su plazo, las respuestas a los pedidos de otros nodos hasta que salen al aire y los eventos `echo`, `echo_lost` y `echo_served` |
| | `test_run_service` | Corridas del emisor y del receptor: cuándo termina cada una, el aviso cuando no queda ninguna y los eventos `run_start`, `run_done`, `test_rx` y `run_end` |
| | `transfer_service` | Transferencia de imágenes: imagen disponible, recepción, ráfagas, reportes dirigidos al nodo y sus eventos; avisa cuándo cambia la versión disponible y cuándo un vecino ya la ejecuta |
| | `activation_controller` | Versión activa y VM: la regla de activación para sus tres causas, el pedido de un HELLO inmediato cuando cambia lo que anuncia, los ticks y los eventos `activation`, `vm`, `vm_print`, `vm_fault` y `program` |
| `src/image/` | `image_format.h` | Cabecera de la imagen; sus largos y desplazamientos están en el contrato |
| | `image_verifier` | Verificación de una imagen completa: formato, firma Ed25519 con libsodium y validación del programa, con el motivo del rechazo (`ImageRejection`) del vocabulario del contrato |
| `src/transfer/` | `image_reception` | Recepción en curso: bytes recibidos, cotas del largo, armado del reporte y plazos de fin de ráfaga y de repetición del reporte |
| | `burst_scheduler` | Ráfagas de la imagen disponible: la que está en curso y las que esperan, fragmentos de a uno, suma de los reportes y resumen de cada ráfaga que termina |
| `src/console/` | `event_sink` | Salida de los eventos JSON (con ArduinoJson), de los errores y del texto de depuración, que va a la consola y al OLED |
| | `event_fields` | Formato de los campos: identificadores, RSSI y SNR con los decimales del contrato y campos de `error` |
| | `console` | Consola en la placa: líneas por todos los transportes, comandos de cualquiera de ellos y texto de depuración en el OLED |
| | `serial_transport`, `wireless_transport` | Transportes de la consola: serie y WebSocket sobre el punto de acceso, que el transporte nombra, enciende y apaga, y del que informa cada cambio |
| | `command_line` | Palabras de una línea de comando y largo máximo de línea que aceptan los transportes |
| | `argument_reader` | Gramática de los valores de los comandos: números en decimal o en hexadecimal con `0x`, valores de registro, identificadores de nodo y fracciones decimales |
| `src/display/` | `debug_display` | OLED: fila de estado y registro de depuración |
| `src/vm/` | `virtual_machine` | Micro VM de registros: validación del programa (`ValidProgram`, el único tipo que la VM carga, y la falla de la primera instrucción mala), ticks, fallas y estado que anuncia el HELLO; los opcodes, su forma de operandos, su efecto y las fallas están en el contrato |

Cada módulo es un par `.h` y `.cpp` con el mismo nombre, salvo los que son solo un encabezado y `board_support.h` y `board_radio.h`, que se implementan en un archivo por modelo. Los `#include` entre carpetas usan rutas relativas. `src/protocol/protocol_contract.h` no se edita a mano: se cambia `firmware/protocol/contract.json` y se ejecuta `node tools/generate_protocol_sources.mjs`.

Los comandos de consola están en una sola tabla, `CONSOLE_COMMANDS`, que el generador escribe en `src/protocol/protocol_contract.h` desde `firmware/protocol/contract.json`. Cada fila tiene el nombre, el uso que lista `help` y que llevan los errores `usage`, el largo máximo de su línea y sus formas: el primer argumento que elige cada forma, la cantidad de argumentos, las precondiciones (`busy` durante una corrida o un eco, `radio_failure` sin radio) y la acción. `src/application/console_commands.cpp` asocia a cada acción la función que la ejecuta. Esa función lee los argumentos con `CommandInvocation`, que usa la gramática de `argument_reader` en todos los comandos y responde `usage` o `out_of_range` con el detalle armado desde los límites del contrato. Los comandos que actúan sobre los servicios, el pedido de eco incluido, usan `NodeServices` y escriben sus errores en `EventSink`; lo que involucra al hardware (la radio, el WiFi y `status`) se lo piden al nodo a través de `CommandTarget`, que implementa `NodeApplication`. El comando `radio` está en `radio_command`: lee las claves con `RadioSettingKey` del contrato, el generador revisa que su uso las liste, y un valor que no es un número responde con el uso de su clave, por ejemplo `sf <7..12>`. Los transportes aceptan la línea más larga que admite algún comando y la capa de comandos aplica el límite de cada uno. En cada pasada del bucle se ejecutan hasta dos líneas (`MAXIMUM_COMMANDS_PER_POLL`), para que la consola no demore la recepción ni la cola de transmisión.

Cada servicio emite sus propios eventos a través de `EventSink`, que en la placa escribe en `Console` y en las pruebas en memoria, y cada evento se elige de `ConsoleEvent`, la enumeración de los eventos del contrato. `NodeServices` conecta los servicios entre sí: el HELLO de un vecino pasa por presencia y llega a la transferencia después del evento `hello`; la transferencia le avisa a la activación y le pide la versión activa para el evento `transfer`; la activación y el fin de la última corrida (`TestRunListener`) llegan a presencia. También tiene la política que cruza los servicios. Cuando el transmisor está libre y la cola vacía, `nextFrame()` encola la trama que corresponde: primero una trama TEST de la corrida, después el HELLO y, solo si los HELLO no están suspendidos, un reporte o un fragmento. `receive()` revisa cada trama recibida en el orden de [la trama](../docs/protocol/frame.md), registra al vecino antes de mirar el destino y le entrega el cuerpo decodificado al servicio de su tipo. Cada trama propia toma la cabecera de su descripción y la secuencia de `SequenceSource`, que en la placa es `NodeIdentity`; una cola llena la rechaza antes de que tome un número de secuencia. `NodeApplication` atiende el hardware y el bucle: lee el reloj una vez por pasada, les pasa esa lectura a todos los módulos que atiende, también a los comandos, y mueve las tramas entre `NodeServices` y `RadioLink`. La suspensión de los HELLO y del OLED se pregunta en el momento de decidir (una corrida activa o una suspensión del operador); el fin de una corrida, en cambio, es un aviso, porque con intervalo 0 el emisor tiene siempre la trama siguiente lista y nadie pregunta por el HELLO mientras la corrida dura.

Cada trama que arma el nodo entra en `TransmitQueue` con su dueño (`FrameOwner`: presencia, eco, corrida, transferencia), con los campos que informa el evento `tx` y con una marca que elige el dueño para reconocerla. La cola le da a cada trama un solo resultado y se lo avisa a su dueño a través de `TransmitListener`: la falla, si la cola o la radio la rechazan, o el inicio y el fin de la transmisión. `RadioLink` devuelve el instante de inicio al empezar la transmisión y el de fin al terminar, con el resultado de la vuelta a la recepción, que el nodo informa como `error` con `detail` `"receive"` cuando falla; la cola guarda los tiempos de la trama en el aire y, antes que al dueño, le avisa el fin a `TransmissionEventWriter`, que escribe el evento `tx`. Una trama que `resend` vuelve a encolar queda a nombre de `Resend`, que nadie escucha, así que no llega a ningún servicio. Cada trama recibida se decodifica una sola vez, con el códec de su tipo (`decodeMessageBody`), y quien la atiende recibe el cuerpo ya decodificado.

Todo corre en el bucle principal. La única tarea que se suma a las del core es la del servidor HTTP de ESP-IDF, que solo mueve líneas de consola ([ADR 0003](../docs/adrs/0003-control-panel-as-pwa-over-websocket.md)).

## Transferencia de imágenes

Las reglas están en [la trama](../docs/protocol/frame.md) y en las ADR [0009](../docs/adrs/0009-self-describing-fragments.md) a [0012](../docs/adrs/0012-image-format-and-operator-key.md). Las imágenes viven solo en RAM: al reiniciarse, el nodo vuelve a la versión 0, sin imagen disponible. `TransferService` guarda la imagen disponible, una recepción en curso y hasta `BURST_QUEUE_CAPACITY` ráfagas. Los fragmentos y los reportes salen de a uno, cuando la cola de transmisión está vacía, así que una ráfaga nunca demora a `loop()` ni a una respuesta de eco. Mientras el nodo manda o recibe una ráfaga, el HELLO periódico espera y el OLED no se redibuja; el HELLO por un cambio de versión sale igual. Mientras los HELLO están suspendidos, no salen fragmentos ni reportes.

`TransferService` emite sus propios eventos y le avisa a `ActivationController`, a través de `TransferListener`, cuándo cambia la versión disponible y cuándo un vecino ya ejecuta esa versión. `ActivationController` decide la activación para las tres causas (consola, HELLO y vecino): la imagen disponible pasa a ser la activa solo si su versión es mayor que la activa. Cada vez que cambia lo que anuncia el HELLO, la versión disponible o la activa, le pide a presencia un HELLO inmediato ([ADR 0011](../docs/adrs/0011-implicit-activation-without-rollback.md)). La VM carga un `ValidProgram`, que solo crea `validateProgram()`, así que no vuelve a validar el programa ni lo revisa instrucción por instrucción al ejecutarlo. La verificación Ed25519 de una imagen completa corre en el bucle principal; su duración en las placas todavía no se midió.

La imagen disponible, la recepción, la imagen que llega por la consola y el búfer de los eventos, que tiene que admitir el evento `program`, suman unos 6,5 KB de RAM. libsodium agrega unos 70 KB de flash.

## Editor

Para que clangd (Zed, VS Code o Neovim) entienda el firmware, se genera `firmware/.clangd` desde la raíz del repositorio:

```sh
tools/generate_clangd_configuration.py              # primer perfil de sketch.yaml, heltec_v4_3
tools/generate_clangd_configuration.py heltec_v2
```

El script pide a arduino-cli la base de compilación del perfil, expande sus opciones y escribe en `.clangd` las definiciones y los directorios de encabezados, incluidos los del compilador de Xtensa. Para `tests/` toma las opciones de `tests/run_host_tests.sh --print-compile-flags`, ArduinoJson incluido. El archivo tiene rutas de cada computadora, así que git lo ignora; hay que volver a generarlo al cambiar de perfil, de core o de bibliotecas. Con el perfil de una placa, el editor muestra como inactivo el código del otro modelo. `.zed/settings.json` hace que Zed trate `firmware.ino` como C++.

## Pruebas

`tests/run_host_tests.sh` compila y ejecuta en la computadora las pruebas de los módulos que no dependen del hardware. Compila todos los `.cpp` de `src/` salvo los que lista en `HARDWARE_SOURCES`, que necesitan el core de ESP32, sus bibliotecas o la placa, así que un módulo nuevo entra en las pruebas sin tocar el script. Compila también todos los `.cpp` de `tests/`: cada `<nombre>_tests.cpp` prueba un módulo, o una carpeta como `message_tests.cpp` los cuerpos de `src/messages/` y `service_tests.cpp` los servicios y sus cadenas. `simulated_network` reemplaza a las radios: conecta varios `NodeServices` por un medio simulado que, en cada pasada, atiende el transmisor y los temporizadores de cada nodo como el bucle principal y entrega cada trama a los demás nodos, salvo las que la prueba decide perder; cada prueba se registra con `J5_HOST_TEST` y no hace falta enumerarla en otro lugar. Un `switch` sobre una enumeración del contrato que no cubre todos sus valores, como una clave nueva de `radio` o un opcode nuevo, es un error de compilación. Antes de compilar, el script ejecuta `node tools/generate_protocol_sources.mjs --check`, que falla si los archivos generados no coinciden con el contrato.

Las pruebas cubren la fórmula del tiempo de aire, el descarte de repetidos, la tabla de vecinos, los servicios de presencia, eco, corridas y transferencia, el controlador de activación y los eventos del nodo (con las líneas exactas que escriben), las cadenas entre servicios de `NodeServices` (la activación por el HELLO de un vecino), su política sobre el medio simulado (el orden de los controles de la recepción, el armado de las tramas, qué sale cuando el transmisor está libre, la suspensión de fragmentos y reportes, el HELLO después de una corrida con intervalo 0 y una actualización entre dos nodos con un fragmento perdido y su reparación), la trama (el vector compartido, cada control de la recepción, la versión del protocolo dentro de la etiqueta y los largos), los parámetros de radio y los textos de sus errores, los cuerpos de todos los mensajes y el rechazo de los mal formados, la cola de transmisión (orden, resultado de cada trama, tiempos y `resend`), el armado de los campos de los eventos, la codificación hexadecimal, la VM, los comandos de consola (palabras de la línea, gramática de los argumentos, precondiciones, largo de las líneas, `help`, los textos de sus errores, su efecto sobre los servicios y cada línea que arman los constructores del panel), la verificación de imágenes, la recepción por bytes y las ráfagas con su resumen. La imagen firmada con el par por defecto, los casos de referencia del tiempo de aire y los programas de la VM con sus resultados son los mismos que prueba el panel: están en `firmware/protocol/test-vectors/` y llegan al firmware como `tests/generated_test_vectors.h`, junto con las tramas de referencia, cuya etiqueta el generador calcula con el HMAC-SHA256 de Node, y las líneas de comando que escribe el panel desde sus constructores. Cada una de esas líneas tiene que ser aceptada por un nodo recién arrancado del modelo de placa al que va: cualquier error cuenta como una falla del constructor, salvo las respuestas al estado de ese nodo que lista `STATE_ANSWERS` en `tests/console_command_tests.cpp` (`run stop` sin corrida, `resend` sin trama enviada, `activate` sin imagen disponible y una imagen sin firma válida).

El script toma ArduinoJson de la versión que fija `sketch.yaml`, de la copia que descarga `mise run setup:firmware` (o la primera compilación con un perfil) o de las bibliotecas del IDE, y falla con un mensaje si esa versión no está instalada. Enlaza la libsodium del sistema (paquete `libsodium` en Arch o `libsodium-dev` en Debian) y, para la revisión del contrato, necesita Node y clang-format, en las versiones de `mise.toml`, y las dependencias del panel, que instala `mise run setup:control`: el formateador de Vite+ que usa el generador es el de `control/node_modules`, en la versión que fija `control/pnpm-workspace.yaml`. La radio, los transportes, el OLED, la identidad del nodo (`node_identity`, que guarda la época en la flash) y `NodeApplication` se prueban sobre las placas.

Cada evento que escriben las pruebas queda registrado, y el script compara el registro con `firmware/protocol/test-vectors/firmware-console-lines.jsonl`: falla si difieren o si algún evento del contrato no aparece en ninguna línea. La prueba `control/src/lib/console/firmware-console-lines.test.ts` del panel lee ese archivo con su parser, así que un cambio de un evento del firmware que el panel no entiende rompe la suite del panel. Si el cambio es intencional, `tests/run_host_tests.sh --update-console-lines` vuelve a escribir el archivo.

## Notas de hardware

- La V4.3 maneja su etapa de RF KCT8103L con GPIO7 (alimentación), GPIO2 (habilitación), GPIO5 (transmisión o LNA puenteado) y el DIO2 del SX1262. Al arrancar, el firmware verifica que la etapa responda como KCT8103L y lo avisa por la consola si no.
- La polaridad de Vext en la V4.3 no está confirmada: el esquemático indica que se enciende en bajo. Si el OLED queda apagado, hay que cambiar `EXTERNAL_POWER_ON_LEVEL` en `src/board/heltec_v4_3.cpp`.
- En la V2, Vext alimenta también el conmutador de RF, así que la radio no funciona con Vext apagado.
- Nunca transmitir sin la antena conectada.
