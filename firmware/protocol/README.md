# Contrato del protocolo

Fuente única de los valores del protocolo que comparten el firmware y el panel de control ([ADR 0013](../../docs/adrs/0013-machine-readable-protocol-contract.md)). La descripción en prosa está en [docs/protocol](../../docs/protocol).

| Archivo | Contenido |
|---|---|
| `contract.json` | Valores base: versiones, identificadores de nodo, trama, modelos de placa, cuerpos de HELLO, ECHO, TEST, FRAGMENT y REPORT, imagen, VM (con la forma y el efecto de cada instrucción), radio, consola (con la tabla de comandos), plazos, los nombres de los eventos y los vocabularios de sus campos |
| `test-vectors/frame.json` | Tramas autenticadas con la clave de red por defecto, con sus campos, su cuerpo y la trama completa; el generador revisa cada etiqueta con el HMAC-SHA256 de Node. Solo lo usa el firmware: el panel no decodifica tramas |
| `test-vectors/signed-image.json` | Imagen firmada con `firmware/protocol/default_operator_key.pem`, con su cabecera, su mensaje firmado y su firma |
| `test-vectors/time-on-air.json` | Casos de referencia de la fórmula de Semtech, en microsegundos y en milisegundos con un decimal, a 125 kHz y a 500 kHz |
| `test-vectors/response-deadlines.json` | Plazos de `echo_lost` y `run_end` para tiempos de aire e intervalos dados, con casos que redondean hacia arriba; el generador los revisa contra su fórmula |
| `test-vectors/virtual-machine.json` | Programas de la VM con los valores que imprimen, los registros y la falla al terminar, y programas que la carga rechaza |
| `test-vectors/firmware-console-lines.jsonl` | Cada evento distinto que escriben las pruebas del firmware en la computadora, una línea por evento. No se edita a mano: lo escribe `firmware/tests/run_host_tests.sh --update-console-lines`, que falla si falta algún evento de `vocabularies.events`, y el panel lo lee con su parser |
| `test-vectors/console-command-lines.jsonl` | Cada línea de comando que arman los constructores del panel en los límites de sus argumentos, con el constructor y el modelo de placa al que va. No se edita a mano: lo escribe la prueba `control/src/lib/commands/console-command-lines.test.ts` con `UPDATE_TEST_VECTORS=1`, y las pruebas del firmware pasan cada línea por la tabla de comandos |

## Archivos generados

`tools/generate_protocol_sources.mjs` revisa que el contrato sea coherente (por ejemplo, que el reporte más largo entre en una trama), calcula los valores derivados y escribe:

- `firmware/src/protocol/protocol_contract.h`: constantes `constexpr`, `enum class` con los códigos que viajan en la trama y con los nombres de los vocabularios, una tabla por modelo de placa (`BOARD_MODEL_DESCRIPTIONS`), la forma de los operandos y el efecto de cada opcode (`INSTRUCTION_ENCODINGS`), la tabla de comandos de la consola (`CONSOLE_COMMANDS`) y los plazos de `echo_lost` y `run_end` (`echoLossDeadlineMillis` y `runReceptionDeadlineMillis`);
- `control/src/lib/protocol/protocol-contract.ts`: constantes, objetos y tuplas `as const`, para armar con ellos los enums de zod y los tipos literales, y las mismas funciones de los plazos;
- `firmware/tests/generated_test_vectors.h`: los vectores de prueba, para las pruebas del firmware en la computadora, y la semilla de `firmware/protocol/default_operator_key.pem`, con la que esas pruebas firman sus imágenes. El panel lee directamente los JSON que usa.

El texto generado pasa por clang-format, en la versión de `mise.toml`, y por el formateador de Vite+ de las dependencias del panel (`mise run setup:control`), en la versión de `control/pnpm-workspace.yaml`, antes de escribirse o de compararse.

Después de cambiar un constructor de comandos del panel, desde `control/`:

```sh
UPDATE_TEST_VECTORS=1 vp test run src/lib/commands/console-command-lines.test.ts
```

y después se regeneran los archivos como se indica abajo.

Los archivos generados no se editan a mano. Después de cambiar el contrato o un vector, desde la raíz del repositorio:

```sh
node tools/generate_protocol_sources.mjs
```

Con `--check`, el script no escribe nada y termina con error, nombrando cada archivo desactualizado, si alguno no coincide con lo que escribiría. También revisa las cifras del contrato que repiten `docs/protocol/` y los ADR: los límites y los tamaños, los parámetros de radio con las potencias de cada modelo de placa, los plazos y las cifras de la VM, pero no los anchos de las tablas de campos, los códigos de las enumeraciones ni los README. Cada frase de `DOCUMENT_MENTIONS`, en el generador, nombra entre llaves los valores que dice, por el nombre de la constante en el encabezado del firmware (`MAXIMUM_PAYLOAD_SIZE`) o por su ruta en `contract.json` (`boardModels.HeltecV2.transmitPowerDbm.minimum`), con una cuenta opcional de izquierda a derecha (`HELLO_PERIOD_MS/1000`, el período en segundos) y, al final, `:es` para la coma decimal y el signo menos del castellano o `:es.1` para fijar además un decimal. El script falla si el documento ya no tiene esa frase con los valores actuales. Al cambiar una de esas frases en un documento, hay que cambiarla también en la lista. Lo ejecutan `mise run check:protocol`, `firmware/tests/run_host_tests.sh` y la prueba `control/src/lib/protocol/protocol-contract.test.ts`.

## Convenciones

- Los números van en decimal o como texto hexadecimal, por ejemplo `"0xFFFF"`.
- Las constantes tienen el mismo nombre en C++ y en TypeScript, salvo el sufijo de la unidad: `_MS`, `_S`, `_MHZ` y `_KHZ` en C++ y `_MILLISECONDS`, `_SECONDS`, `_MEGAHERTZ` y `_KILOHERTZ` en TypeScript.
- Cada archivo generado lleva solo lo que usa su lado: el encabezado del firmware no tiene, por ejemplo, las tuplas de nombres, los límites de ADR 0004 ni la URL de la consola, que solo usa el panel. Una definición que un solo lado usa se marca en el generador con `tsOnly` o `cppOnly`.
- Las claves del comando `radio` (`radio.settingKeys`) son en el firmware la enumeración `RadioSettingKey`: el firmware lee las claves con ella, y una clave nueva sin su caso en `firmware/src/application/radio_command.cpp` no compila en las pruebas del firmware. El generador revisa que el uso de `radio` en la tabla de comandos liste esas claves. `radio.frequencyMegahertz.rangeDecimals` fija con cuántos decimales se escriben los límites de la frecuencia.
- Los nombres de los eventos (`vocabularies.events`) son en el firmware la enumeración `ConsoleEvent`, la única forma de empezar un evento, y en el panel la tupla `CONSOLE_EVENTS`, de la que sale `CONSOLE_EVENT_NAMES`.
- La tabla de comandos (`console.commands`) da el nombre, el uso, las formas, las precondiciones y la acción de cada forma de cada comando. Cada precondición (`console.commandPreconditions`) lleva lo que el nodo tiene que cumplir y el error con que se rechaza; en el firmware es la enumeración `CommandPrecondition`, que `console_commands.cpp` evalúa con un `switch`, así que una precondición nueva sin su caso no compila. En el firmware es `CONSOLE_COMMANDS`, y `firmware/src/application/console_commands.cpp` asocia una función a cada acción (`CommandAction`); en el panel es la tupla `CONSOLE_COMMANDS`, que despacha el nodo simulado y de la que salen el largo de línea de cada comando y las líneas fijas de los constructores. Una cantidad de argumentos puede nombrar una cantidad del contrato, `registerCount` o `settingKeyPairs`, y el generador revisa que el uso la refleje. `console.errorCommandWordLength` es el largo del campo `cmd` de un error para una línea que no nombra ningún comando.
- El efecto de cada instrucción (`virtualMachine.instructionEffects`) decide qué hace la VM del firmware con ella; cada efecto lista las formas de operandos que admite.
- Cada modelo de placa (`boardModels`) lleva su transceptor, sus potencias, los rangos de potencia en los que la hoja de datos limita el ciclo de trabajo y su perfil de compilación (`buildProfile`), que tiene que ser uno de `firmware/sketch.yaml`.
- `image.formatDefects` lista, en el orden de los controles, los defectos de formato de una imagen con el texto que sigue a `format: ` en el `detail` de `invalid_image`; el firmware los escribe y el nodo simulado del panel los repite.
- `timings.neighborExpiry.expiresAtBoundary` en `true` indica que un vecino vence en el instante exacto en que se cumple el plazo, como en el firmware. Las fórmulas de los plazos de `echo_lost` y `run_end` las escribe el generador para los dos lados, a partir de `timings.responseMarginMilliseconds`.
- El contrato no lleva secretos: la clave de red y la clave pública del operador siguen en `firmware/src/configuration.h`. `test-vectors/frame.json` repite la clave de red por defecto, que es la de desarrollo, y la prueba del firmware que lo usa revisa que coincida.
