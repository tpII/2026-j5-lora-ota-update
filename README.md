# J5 LoRa OTA Update

[Panel de control ↗︎](https://
j5-lora-ota.finisterre.app)

Red de nodos ESP32 con LoRa que distribuyen entre pares programas para una micro VM propia y los activan de forma coordinada. Proyecto J5 de Taller de Proyecto II (Facultad de Ingeniería, UNLP, 2026), grupo integrado por Lautaro Joaquín Bermúdez, Lorenzo Majoros y Juan Martín Seery.

## Estructura del repositorio

| Ruta                  | Contenido                                           |
| --------------------- | --------------------------------------------------- |
| `CONTEXT.md`          | Directivas del repositorio y glosario, en inglés    |
| `docs/E1-J5.pdf`      | Plan de proyecto entregado a la cátedra (E1)        |
| `docs/adrs/`          | Registro de decisiones de arquitectura              |
| `docs/protocol/`      | Contratos: parámetros de radio, trama y consola     |
| `docs/future-work.md` | Tareas postergadas a propósito                      |
| `firmware/`           | Sketch de Arduino de los nodos                      |
| `control/`            | Panel de control: aplicación web con Svelte y Vite+ |
| `measurements/`       | Datos crudos de las mediciones                      |

## Puesta en marcha

- Firmware: ver [`firmware/README.md`](firmware/README.md).
- Panel de control: ver [`control/README.md`](control/README.md).

Las herramientas (arduino-cli, Typst y Vite+) se instalan con `mise install` según `mise.toml`.

## Convenciones

Las reglas de redacción, nombres, estilo de código, decisiones y control de versiones están en [`CONTEXT.md`](CONTEXT.md). Toda desviación del plan entregado se registra en una ADR.
