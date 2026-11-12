/**
 * The transfer activity of the connected nodes, as the update section lists it: bursts, reports
 * received and sent, images that became available or were rejected and activations, newest first,
 * described in Spanish.
 */
import type {
  ActivationCause,
  BurstCause,
  ImageRejectionReason,
  NodeIdentifier,
} from "$lib/console/console-event.ts";
import type { NodeState } from "$lib/node-session/node-state.ts";
import { countWithNoun, formatImageVersion, formatNumber } from "$lib/utils/format.ts";
import { imageReceptionFraction } from "$lib/nodes/node-update-state.ts";

const IMAGE_REJECTION_LABELS: { readonly [Reason in ImageRejectionReason]: string } = {
  format: "formato inválido",
  signature: "firma inválida",
  program: "el programa no pasa la validación de la VM",
};

const BURST_CAUSE_LABELS: { readonly [Cause in BurstCause]: string } = {
  load: "carga por la consola",
  complete: "imagen completada por la radio",
  hello: "HELLO de un vecino con una versión disponible menor",
  report: "reporte de un receptor",
};

const ACTIVATION_CAUSE_LABELS: { readonly [Cause in ActivationCause]: string } = {
  console: "orden del operador",
  hello: "HELLO que la anuncia como activa",
  neighbor: "un vecino ya la tenía activa",
};

export interface TransferActivityRow {
  /** Unique within the list. */
  readonly key: string;
  readonly hostTime: number;
  readonly node: NodeIdentifier;
  readonly kind: string;
  readonly detail: string;
}

function fragments(count: number): string {
  return countWithNoun(count, "fragmento", "fragmentos");
}

function missingOf(missing: number, fragmentCount: number): string {
  return `${missing === 1 ? "falta" : "faltan"} ${missing} de ${fragments(fragmentCount)}`;
}

function activityOf(id: NodeIdentifier, state: NodeState): TransferActivityRow[] {
  const rows: TransferActivityRow[] = [];
  for (const [index, burst] of state.bursts.entries()) {
    const sent =
      burst.completion === null
        ? `${countWithNoun(burst.transmitted, "enviado", "enviados")} hasta ahora`
        : countWithNoun(burst.completion.sent, "enviado", "enviados");
    rows.push({
      key: `${id}:burst:${index}`,
      hostTime: burst.startHostTime,
      node: id,
      kind: "Ráfaga",
      detail:
        `${burst.version}: ${fragments(burst.count)} de ${burst.fragmentSize} bytes, ${sent}; ` +
        `${BURST_CAUSE_LABELS[burst.cause]}${burst.trigger === null ? "" : ` (${burst.trigger})`}`,
    });
  }
  for (const [index, report] of state.reportsReceived.entries()) {
    rows.push({
      key: `${id}:report:${index}`,
      hostTime: report.hostTime,
      node: id,
      kind: "Reporte recibido",
      detail: `de ${report.peer}, versión ${report.version}: ${missingOf(report.missing.length, report.fragmentCount)} (${report.missing.join(", ")})`,
    });
  }
  const lastReport = state.imageReception?.lastReport ?? null;
  if (lastReport !== null) {
    rows.push({
      key: `${id}:sent:${lastReport.hostTime}`,
      hostTime: lastReport.hostTime,
      node: id,
      kind: "Reporte enviado",
      detail: `a ${lastReport.peer}, versión ${lastReport.version}, ronda ${lastReport.round ?? "—"}: ${missingOf(lastReport.missing.length, lastReport.fragmentCount)}`,
    });
  }
  for (const [index, image] of state.images.entries()) {
    rows.push({
      key: `${id}:image:${index}`,
      hostTime: image.hostTime,
      node: id,
      kind: "Imagen disponible",
      detail:
        image.via === "console"
          ? `${image.version}, cargada por la consola (${formatNumber(image.imageSize)} bytes)`
          : `${image.version}, completada por la radio desde ${image.source ?? "—"}: ${fragments(image.fragments)}, ${countWithNoun(image.reports, "reporte", "reportes")}, ${formatNumber(image.durationMilliseconds)} ms`,
    });
  }
  for (const [index, rejection] of state.imageRejections.entries()) {
    rows.push({
      key: `${id}:rejection:${index}`,
      hostTime: rejection.hostTime,
      node: id,
      kind: "Imagen rechazada",
      detail: `${rejection.version} desde ${rejection.source}: ${IMAGE_REJECTION_LABELS[rejection.reason]}`,
    });
  }
  for (const [index, activation] of state.activations.entries()) {
    rows.push({
      key: `${id}:activation:${index}`,
      hostTime: activation.hostTime,
      node: id,
      kind: "Activación",
      detail:
        `${activation.version} (antes ${formatImageVersion(activation.previous)}): ` +
        `${ACTIVATION_CAUSE_LABELS[activation.cause]}${activation.source === null ? "" : ` (${activation.source})`}`,
    });
  }
  return rows;
}

/** The newest `limit` rows of activity of the nodes, each one by its identifier. */
export function buildTransferActivity(
  states: ReadonlyMap<NodeIdentifier, NodeState>,
  limit: number,
): TransferActivityRow[] {
  return [...states]
    .flatMap(([id, state]) => activityOf(id, state))
    .sort((first, second) => second.hostTime - first.hostTime)
    .slice(0, limit);
}

/** The image a node is receiving: "4: 3 de 5 fragmentos de 231 bytes (60 %), faltan 462 bytes". */
export function describeImageReception(state: NodeState): string {
  const reception = state.imageReception;
  const transfer = state.transfer;
  if (reception !== null) {
    const percent = Math.round(100 * imageReceptionFraction(reception));
    const missing =
      transfer !== null &&
      transfer.receivingVersion === reception.version &&
      transfer.missingBytes !== null
        ? `, faltan ${formatNumber(transfer.missingBytes)} bytes`
        : "";
    return `${reception.version}: ${reception.heldFragments.length} de ${fragments(reception.fragmentCount)} de ${reception.fragmentSize} bytes (${percent} %)${missing}`;
  }
  if (transfer !== null && transfer.receivingVersion !== null) {
    return `${transfer.receivingVersion}: faltan ${formatNumber(transfer.missingBytes)} bytes`;
  }
  return "ninguna";
}
