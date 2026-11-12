/**
 * Spanish texts for the reasons of the `error` event, which several features show. The table is
 * keyed by the type of the contract, so a reason added to the contract needs its text here. The
 * labels of a single feature live next to the code that shows them, and those of the VM faults in
 * $lib/vm/fault-descriptions.ts.
 */
import { isKnownErrorReason, type KnownErrorReason } from "$lib/console/console-event.ts";
import { CONSOLE_LINE_CAPACITY } from "$lib/protocol/protocol-contract.ts";

/** Meaning of each reason of the `error` event (docs/protocol/console.md). */
const ERROR_REASON_DESCRIPTIONS: { readonly [Reason in KnownErrorReason]: string } = {
  unknown_command: "el comando no existe",
  usage: "faltan argumentos o sobran",
  out_of_range: "un valor está fuera del rango admitido",
  unreachable_power: "el modelo de placa no puede entregar esa potencia",
  not_supported: "el parámetro no existe en este modelo",
  busy: "hay una corrida o un eco en curso",
  not_available: "la versión de activate no es la disponible",
  radio_failure: "la radio rechazó la operación",
  wifi_failure: "no se pudo encender el punto de acceso",
  line_too_long: `la línea supera los ${CONSOLE_LINE_CAPACITY} caracteres (o el largo de una imagen, en load_image)`,
  version_not_newer:
    "la versión de load_image no es mayor que la disponible, o la de activate no es mayor que la activa",
  invalid_image: "la imagen no es hexadecimal o no pasa la verificación",
};

export function describeErrorReason(reason: string): string {
  return isKnownErrorReason(reason)
    ? ERROR_REASON_DESCRIPTIONS[reason]
    : "motivo que este panel no conoce";
}
