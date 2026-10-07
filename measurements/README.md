# Mediciones

Cada exportación del panel de control queda en una carpeta propia:

```
measurements/<AAAA-MM-DD>-<prueba>-<NN>/
```

- `<prueba>` es `power-sweep` (barrido de potencia) o `capacity-test` (prueba de capacidad).
- `<NN>` es un número de dos dígitos que distingue las exportaciones de un mismo día, desde `01`.

## Archivos

| Archivo | Contenido |
|---|---|
| `metadata.json` | Ficha de la medición |
| `events.jsonl` | Todos los eventos recibidos de los nodos que participaron, uno por línea |
| `summary.csv` | Una fila por corrida |

### `metadata.json`

| Campo | Descripción |
|---|---|
| `test` | `"power-sweep"` o `"capacity-test"` |
| `date` | Fecha y hora de la exportación, en ISO 8601 |
| `place` | Lugar de la medición |
| `distance_m` | Distancia entre los nodos en metros, o `null` |
| `antennas` | Descripción de las antenas o de las cargas usadas |
| `operators` | Personas que midieron |
| `notes` | Observaciones libres |
| `nodes` | Lista de objetos `{ "id", "model" }` con los nodos que participaron |
| `panel_version` | Versión del panel de control que exportó |

### `events.jsonl`

Cada línea es un evento tal como lo emitió el firmware (ver [consola](../docs/protocol/console.md)), con dos campos que agrega el panel:

| Campo | Descripción |
|---|---|
| `node` | Identificador del nodo cuya consola emitió el evento |
| `host_time` | Milisegundos desde el 1 de enero de 1970 en la computadora, al recibir el evento |

### `summary.csv`

Archivo CSV con separador coma, punto decimal y una fila de encabezado con estas columnas:

| Columna | Descripción |
|---|---|
| `run` | Número de corrida del emisor |
| `sender`, `receiver` | Identificadores del emisor y del receptor |
| `sender_model`, `receiver_model` | Modelos de placa |
| `freq`, `sf`, `bw`, `cr`, `preamble` | Parámetros de radio de la corrida |
| `power` | Potencia de transmisión del emisor, en dBm |
| `receiver_lna` | Modo del LNA del receptor: `on`, `bypass` o vacío en la V2 |
| `size` | Largo del cuerpo de cada paquete, en bytes |
| `count`, `sent`, `received` | Paquetes pedidos, transmitidos y recibidos |
| `pdr` | `received / count` |
| `rssi_avg`, `rssi_min`, `rssi_max`, `snr_avg` | Calidad de los paquetes recibidos |
| `toa_avg` | Tiempo de aire medido en el emisor, promedio, en µs |
| `toa_calc` | Tiempo de aire según la fórmula de Semtech, en µs |
| `duration` | Duración de la corrida en el emisor, en µs |
| `goodput` | `received × size × 8 / duration`, en bits por segundo |
| `reason` | `complete` o `timeout`, según `run_end` |
