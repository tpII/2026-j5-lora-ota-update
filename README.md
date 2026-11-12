# J5 LoRa OTA Update

[Panel de control ↗︎](https://
j5-lora-ota.finisterre.app)

Red de nodos ESP32 con LoRa que distribuyen entre pares programas para una micro VM propia y los activan de forma coordinada. Proyecto J5 de Taller de Proyecto II (Facultad de Ingeniería, UNLP, 2026), grupo integrado por Lautaro Joaquín Bermúdez, Lorenzo Majoros y Juan Martín Seery.

## Estructura del repositorio

| Ruta                          | Contenido                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `CONTEXT.md`                  | Directivas del repositorio y glosario, en inglés                                    |
| `docs/E1-J5.pdf`              | Plan de proyecto entregado a la cátedra (E1)                                        |
| `docs/adrs/`                  | Registro de decisiones de arquitectura                                              |
| `docs/protocol/`              | Contratos: parámetros de radio, trama, imagen, VM y consola                         |
| `docs/future-work.md`         | Tareas postergadas a propósito                                                      |
| `docs/measurement-exports.md` | Formato de las exportaciones de mediciones del panel                                |
| `firmware/`                   | Sketch de Arduino de los nodos                                                      |
| `firmware/protocol/`          | Contrato legible por máquina, vectores de prueba y clave del operador de desarrollo |
| `control/`                    | Panel de control: aplicación web con Svelte y Vite+                                 |
| `tools/`                      | Generador de las fuentes del contrato y scripts auxiliares                          |

## Puesta en marcha

- Firmware: ver [`firmware/README.md`](firmware/README.md).
- Panel de control: ver [`control/README.md`](control/README.md).

Las herramientas (arduino-cli, Node, clang-format, Typst y Vite+) se instalan con `mise install`, en las versiones que fija `mise.toml`. Después, `mise run setup` descarga el core de ESP32 y las bibliotecas de cada perfil de `firmware/sketch.yaml`, ArduinoJson incluida, que también usan las pruebas del firmware en la computadora, e instala las dependencias del panel; hay que volver a correrlo después de cambiar `sketch.yaml` o las dependencias del panel. Una vez instalado todo, las comprobaciones funcionan sin conexión. Del sistema hacen falta además un compilador de C++ (`c++`, por ejemplo GCC o Clang), libsodium con sus encabezados (paquete `libsodium` en Arch o `libsodium-dev` en Debian) y Python 3, que usa `tools/generate_clangd_configuration.py`.

`mise run check` corre todas las comprobaciones del repositorio: las fuentes generadas del contrato y los valores que repite la documentación, el formato del firmware, las pruebas del firmware en la computadora, la compilación del firmware para cada modelo de placa, que cubre las fuentes que esas pruebas dejan afuera, y el formato, el análisis, los tipos y las pruebas del panel y de los scripts de `tools/`. `mise run build:firmware` solo compila el firmware para cada perfil de `sketch.yaml`.

## Convenciones

Las reglas de redacción, nombres, estilo de código, decisiones y control de versiones están en [`CONTEXT.md`](CONTEXT.md). Toda desviación del plan entregado se registra en una ADR.
