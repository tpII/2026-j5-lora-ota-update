/** Spanish texts for the values the panel shows. */
import type { CampaignStatus, PointStatus } from "$lib/measurements/capacity-test-campaign.ts";
import type { CapacityTestSeries } from "$lib/measurements/capacity-test-plan.ts";
import type { ConsoleEventName, LnaMode } from "$lib/console/console-event.ts";
import type { MeasurementTest } from "$lib/measurements/measurement-export.ts";
import type { ConnectionStatus } from "$lib/nodes/node-connection.ts";
import type { ReceptionOutcome } from "$lib/measurements/test-run-ledger.ts";
import type { TransportKind } from "$lib/transports/console-transport.ts";

export const EVENT_DESCRIPTIONS: { readonly [Name in ConsoleEventName]: string } = {
  boot: "arranque",
  radio: "parámetros de radio",
  wifi: "punto de acceso",
  status: "estado",
  neighbor: "vecino",
  tx: "transmisión",
  hello: "HELLO recibido",
  echo_served: "eco respondido",
  echo: "eco recibido",
  echo_lost: "eco perdido",
  run_start: "comienzo de corrida",
  run_done: "fin de corrida en el emisor",
  test_rx: "paquete de corrida",
  run_end: "fin de corrida en el receptor",
  duplicate: "paquete repetido",
  drop: "paquete descartado",
  id_conflict: "identificador repetido",
  error: "error",
};

/** Meaning of each reason of the `error` event (docs/protocol/console.md). */
const ERROR_REASON_DESCRIPTIONS: Readonly<Record<string, string>> = {
  unknown_command: "el comando no existe",
  usage: "faltan argumentos o sobran",
  out_of_range: "un valor está fuera del rango admitido",
  unreachable_power: "el modelo de placa no puede entregar esa potencia",
  not_supported: "el parámetro no existe en este modelo",
  busy: "hay una corrida o un eco en curso",
  radio_failure: "la radio rechazó la operación",
  wifi_failure: "no se pudo encender el punto de acceso",
  line_too_long: "la línea supera los 200 caracteres",
};

export function describeErrorReason(reason: string): string {
  return ERROR_REASON_DESCRIPTIONS[reason] ?? "motivo que este panel no conoce";
}

export const CONNECTION_STATUS_LABELS: { readonly [Status in ConnectionStatus]: string } = {
  opening: "Abriendo",
  open: "Conectado",
  closing: "Cerrando",
  closed: "Desconectado",
};

export const TRANSPORT_LABELS: { readonly [Kind in TransportKind]: string } = {
  serial: "USB",
  websocket: "WiFi",
};

export const POINT_STATUS_LABELS: { readonly [Status in PointStatus]: string } = {
  pending: "Pendiente",
  configuring: "Configurando la radio",
  transmitting: "Transmitiendo",
  completed: "Completo",
  failed: "Falló",
  stopped: "Detenido",
};

export const CAMPAIGN_STATUS_LABELS: { readonly [Status in CampaignStatus]: string } = {
  ready: "Lista para empezar",
  running: "En curso",
  pausing: "Se pausa al terminar el punto en curso",
  paused: "En pausa",
  stopping: "Deteniendo",
  stopped: "Detenida",
  finished: "Terminada",
};

export const SERIES_LABELS: { readonly [Series in CapacityTestSeries]: string } = {
  modulation: "Modulación",
  payload_size: "Largo del cuerpo",
  coding_rate: "Tasa de código",
};

export const RECEPTION_OUTCOME_LABELS: { readonly [Outcome in ReceptionOutcome]: string } = {
  receiving: "Recibiendo",
  complete: "Completa",
  timeout: "Terminada por plazo",
  no_reception: "Sin paquetes",
};

export const MEASUREMENT_TEST_LABELS: { readonly [Test in MeasurementTest]: string } = {
  "power-sweep": "Barrido de potencia",
  "capacity-test": "Prueba de capacidad",
};

export function describeLnaMode(mode: LnaMode | null): string {
  if (mode === null) {
    return "sin LNA";
  }
  return mode === "on" ? "LNA activo" : "LNA puenteado";
}

/** "1 cliente", "2 clientes". */
export function countWithNoun(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
