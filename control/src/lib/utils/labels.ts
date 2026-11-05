/** Spanish texts for the values the panel shows. */
import type { CampaignStatus, PointStatus } from "$lib/measurements/capacity-test-campaign.ts";
import type { CapacityTestSeries } from "$lib/measurements/capacity-test-plan.ts";
import type { CommunicationTestStatus } from "$lib/measurements/communication-test.ts";
import type { ReceiverModeStatus } from "$lib/measurements/communication-receiver.ts";
import type {
  ActivationCause,
  BurstCause,
  ConsoleEventName,
  ImageRejectionReason,
  LnaMode,
} from "$lib/console/console-event.ts";
import type { MeasurementTest } from "$lib/measurements/measurement-export.ts";
import type { ActivationBlockReason, GraphNodeSource } from "$lib/nodes/connection-graph.ts";
import type { ConnectionStatus } from "$lib/nodes/node-connection.ts";
import type { ReceptionOutcome } from "$lib/measurements/test-run-ledger.ts";
import type { TransportKind } from "$lib/transports/console-transport.ts";
import type { VmFault } from "$lib/vm/virtual-machine.ts";

export const EVENT_DESCRIPTIONS: { readonly [Name in ConsoleEventName]: string } = {
  boot: "arranque",
  radio: "parámetros de radio",
  wifi: "punto de acceso",
  presence: "estado de los HELLO",
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
  vm: "estado de la VM",
  vm_print: "salida de la VM",
  vm_fault: "falla de la VM",
  transfer: "estado de la transferencia",
  image: "imagen disponible",
  image_rejected: "imagen rechazada",
  fragment_rx: "fragmento recibido",
  burst_start: "comienzo de ráfaga",
  burst_done: "fin de ráfaga",
  report_sent: "reporte enviado",
  report_received: "reporte recibido",
  activation: "activación",
  program: "programa activo",
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
  not_available: "la versión de activate no es la disponible",
  radio_failure: "la radio rechazó la operación",
  wifi_failure: "no se pudo encender el punto de acceso",
  line_too_long: "la línea supera los 200 caracteres (o el largo de una imagen, en load_image)",
  version_not_newer:
    "la versión de load_image no es mayor que la disponible, o la de activate no es mayor que la activa",
  invalid_image: "la imagen no es hexadecimal o no pasa la verificación",
};

export const VM_FAULT_LABELS: { readonly [Fault in VmFault]: string } = {
  division_by_zero: "división por cero",
  instruction_limit: "se superó el tope de instrucciones del tick",
  end_of_program: "el programa terminó sin HALT",
  invalid_opcode: "opcode inválido",
  invalid_register: "registro inválido",
  truncated_instruction: "instrucción incompleta al final del programa",
};

export const IMAGE_REJECTION_LABELS: { readonly [Reason in ImageRejectionReason]: string } = {
  format: "formato inválido",
  signature: "firma inválida",
  program: "el programa no pasa la validación de la VM",
};

export const BURST_CAUSE_LABELS: { readonly [Cause in BurstCause]: string } = {
  load: "carga por la consola",
  complete: "imagen completada por la radio",
  hello: "HELLO de un vecino con una versión disponible menor",
  report: "reporte de un receptor",
};

export const ACTIVATION_CAUSE_LABELS: { readonly [Cause in ActivationCause]: string } = {
  console: "orden del operador",
  hello: "HELLO que la anuncia como activa",
  neighbor: "un vecino ya la tenía activa",
};

export const ACTIVATION_BLOCK_REASON_LABELS: {
  readonly [Reason in ActivationBlockReason]: string;
} = {
  unknown: "no se conoce su versión disponible",
  missing: "todavía no tiene la imagen",
  newer: "tiene disponible una versión mayor",
};

export const GRAPH_NODE_SOURCE_LABELS: { readonly [Source in GraphNodeSource]: string } = {
  console: "consola",
  neighbor: "HELLO de un vecino",
  neighbor_list: "lista de vecinos de otro nodo",
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

export const COMMUNICATION_TEST_STATUS_LABELS: {
  readonly [Status in CommunicationTestStatus]: string;
} = {
  ready: "Lista para empezar",
  preparing: "Suspendiendo los HELLO y aplicando la modulación",
  measuring: "Enviando ecos",
  restoring: "Restableciendo la radio y los HELLO",
  finished: "Terminada",
  stopped: "Detenida",
  failed: "Falló",
};

export const RECEIVER_MODE_STATUS_LABELS: { readonly [Status in ReceiverModeStatus]: string } = {
  activating: "Suspendiendo los HELLO y aplicando la modulación",
  active: "Activo: responde ecos",
  deactivating: "Restableciendo la radio y los HELLO",
  inactive: "Desactivado",
  failed: "No se pudo activar",
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
