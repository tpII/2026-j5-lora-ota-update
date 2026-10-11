# Mediciones

Cada exportación del panel de control queda en una carpeta propia:

```
measurements/<AAAA-MM-DD>-<prueba>-<NN>/
```

- `<prueba>` es `power-sweep` (barrido de potencia), `capacity-test` (prueba de capacidad) o `communication-test` (prueba de comunicación).
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
| `test` | `"power-sweep"`, `"capacity-test"` o `"communication-test"` |
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

## Prueba de comunicación

La pestaña Prueba de comunicación exporta, en cada uno de los dos nodos, una carpeta propia `<AAAA-MM-DD>-communication-test-<NN>/` con cuatro archivos:

- `metadata.json`: los campos de arriba, más:
  - `role`: `"sender"` en el emisor y `"receiver"` en el receptor;
  - `node`: el nodo conectado;
  - `destination`: el vecino al que el emisor pidió los ecos, o `null` en el receptor;
  - `settings`: un objeto con `freq`, `preamble`, `sync`, `sf`, `bw`, `cr`, `size` y `count`; `size` y `count` son `null` en el receptor.
- `events.jsonl`: los eventos del nodo conectado mientras duró la prueba o estuvo activo el modo receptor.
- `summary.csv`: las métricas; sus columnas dependen del modo.
- `echoes.csv`: una fila por eco; sus columnas dependen del modo.

La ida es el pedido, medido en el receptor; la vuelta es la respuesta, medida en el emisor.

### `summary.csv` del emisor

Una sola fila.

| Columna | Descripción |
|---|---|
| `requester`, `responder` | Identificadores del emisor y del vecino |
| `requester_model` | Modelo de placa del emisor |
| `freq`, `sf`, `bw`, `cr`, `preamble` | Parámetros de radio de la prueba |
| `power` | Potencia de transmisión del emisor, en dBm |
| `size` | Largo del cuerpo de cada eco, en bytes |
| `frame_size` | Largo de cada trama, cabecera y etiqueta incluidas, en bytes |
| `count` | Ecos pedidos al empezar |
| `requested`, `answered`, `lost` | Ecos enviados, respondidos y perdidos |
| `pdr` | `answered / requested` |
| `forward_rssi_avg`, `forward_rssi_min`, `forward_rssi_max` | RSSI de ida, en dBm |
| `forward_snr_avg`, `forward_snr_min`, `forward_snr_max` | SNR de ida, en dB |
| `reverse_rssi_avg`, `reverse_rssi_min`, `reverse_rssi_max` | RSSI de vuelta, en dBm |
| `reverse_snr_avg`, `reverse_snr_min`, `reverse_snr_max` | SNR de vuelta, en dB |
| `rtt_avg`, `rtt_min`, `rtt_max` | Tiempo de ida y vuelta, en µs |
| `toa_calc` | Tiempo de aire de cada trama según la fórmula de Semtech, en µs |
| `nominal_bitrate` | `SF × BW / 2^SF × 4 / CR`, en bits por segundo |
| `useful_share` | `size / frame_size`: proporción de cada trama que es cuerpo |
| `useful_bits` | `answered × 2 × size × 8`: bits de cuerpo entregados en los dos sentidos |
| `useful_bitrate` | `useful_bits` sobre la suma de los RTT, en bits por segundo |
| `status` | `finished`, `stopped` o `failed` |

### `echoes.csv` del emisor

| Columna | Descripción |
|---|---|
| `n` | Número de eco que asignó el emisor |
| `host_time` | Milisegundos desde el 1 de enero de 1970 en la computadora, al recibir el resultado |
| `outcome` | `answered` o `lost` |
| `rtt` | Tiempo de ida y vuelta, en µs; vacío si se perdió |
| `forward_rssi`, `forward_snr` | Calidad de ida; vacía si se perdió |
| `reverse_rssi`, `reverse_snr` | Calidad de vuelta; vacía si se perdió |

### `summary.csv` del receptor

Una fila por cada emisor cuyos ecos respondió el nodo.

| Columna | Descripción |
|---|---|
| `node`, `node_model` | Identificador y modelo de placa del receptor |
| `source` | Identificador del emisor |
| `freq`, `sf`, `bw`, `cr`, `preamble` | Parámetros de radio del modo receptor |
| `power`, `lna` | Potencia de transmisión del receptor, en dBm, y modo de su LNA |
| `served` | Ecos respondidos |
| `rssi_avg`, `rssi_min`, `rssi_max` | RSSI de los pedidos recibidos, en dBm |
| `snr_avg`, `snr_min`, `snr_max` | SNR de los pedidos recibidos, en dB |
| `first_host_time`, `last_host_time` | Hora de la computadora del primer y del último eco respondido |

### `echoes.csv` del receptor

| Columna | Descripción |
|---|---|
| `n` | Número de eco que asignó el emisor |
| `host_time` | Milisegundos desde el 1 de enero de 1970 en la computadora, al responder |
| `src` | Identificador del emisor |
| `size` | Largo del cuerpo, en bytes |
| `rssi`, `snr` | Calidad con que llegó el pedido |
