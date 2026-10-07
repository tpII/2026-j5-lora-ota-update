# Parámetros de radio

Contrato entre los nodos y con el panel de control. Dos nodos se escuchan solo si comparten la frecuencia, la modulación (SF, BW y CR), el preámbulo y la palabra de sincronismo. La potencia de transmisión y el modo del LNA son propios de cada nodo y no hace falta coordinarlos.

## Valores por defecto

Cada nodo arranca con estos valores. El comando `radio` los cambia en caliente y `radio reset` los restablece (ver [consola](console.md)).

| Parámetro | Valor | Clave del comando |
|---|---|---|
| Frecuencia central | 915,9 MHz | `freq` |
| Factor de dispersión | SF7 | `sf` |
| Ancho de banda | 500 kHz | `bw` |
| Tasa de código | 4/5 | `cr` (se indica el denominador: `5`) |
| Preámbulo | 8 símbolos | `preamble` |
| Palabra de sincronismo | 0x12 (privada) | `sync` |
| Potencia de transmisión | +4 dBm en el conector de antena | `power` |
| LNA de la V4.3 | puenteado | `lna` |

La frecuencia por defecto corresponde a un canal de 500 kHz del plan AU915 que queda fuera de la subbanda 2, la que usa The Things Network. La cabecera LoRa es siempre explícita, con CRC e IQ normal.

## Rangos admitidos

| Clave | Rango |
|---|---|
| `freq` | 915,0 a 928,0 MHz |
| `sf` | 7 a 12 |
| `bw` | 125, 250 o 500 kHz |
| `cr` | 5 a 8 (de 4/5 a 4/8) |
| `preamble` | 6 a 65535 símbolos |
| `sync` | 0 a 255 |
| `power` | V2: 2 a 17 o 20 dBm. V4.3: 4 a 28 dBm |
| `lna` | `on` o `bypass`, solo en la V4.3 |

SF5 y SF6 no son compatibles entre el SX1276 y el SX1262. Por debajo de 125 kHz, la diferencia de frecuencia entre el cristal de la V2 y el TCXO de la V4.3 puede superar la tolerancia del receptor.

## Potencia de transmisión

La potencia se expresa siempre en el conector de antena, sea cual sea el modelo. El firmware la traduce al ajuste del transceptor y el evento `radio` informa los dos valores.

- V2: el SX1276 transmite por la salida PA_BOOST, así que la potencia en la antena coincide con el ajuste. RadioLib no admite 18 ni 19 dBm. A 20 dBm, la hoja de datos del SX1276 limita el ciclo de trabajo al 1 %.
- V4.3: la etapa de RF externa (KCT8103L) suma una ganancia que depende del ajuste del SX1262:

| Ajuste del SX1262 | Ganancia | Potencia en la antena |
|---|---|---|
| −9 a 13 dBm | 13 dB | 4 a 26 dBm |
| 15 dBm | 12 dB | 27 dBm |
| 17 dBm | 11 dB | 28 dBm |

En el aire solo se usan canales de 500 kHz y hasta unos 26 dBm; los canales de 125 y 250 kHz quedan para el banco, con atenuadores o cargas ([ADR 0004](../adrs/0004-only-500-khz-channels-on-air.md)). Por ahora el firmware no lo impone y la responsabilidad es del operador.

## LNA de la V4.3

La etapa de RF de la V4.3 incluye un amplificador de bajo ruido (LNA) de 21 dB. Con el LNA activo, una señal de más de unos −21 dBm en la antena satura el SX1262 y puede dañarlo. Sobre la mesa, a un metro, una V2 a 20 dBm llega con unos −8 dBm. Por eso la V4.3 arranca con el LNA puenteado, y se activa a mano para las pruebas a distancia.

## Detalles de implementación

- El firmware sube el límite de corriente de los dos transceptores a 140 mA, porque RadioLib lo deja en 60 mA y eso recorta la potencia alta.
- El SX1262 recibe con la ganancia reforzada (*boosted gain*), que mejora la sensibilidad.
- El RSSI del SX1276 se corrige con el factor 16/15 que indica su hoja de datos para SNR positiva, porque RadioLib no lo aplica.

## Cuidados

- Nunca transmitir sin la antena conectada.
- Sobre la mesa, usar la potencia mínima y el LNA puenteado.
