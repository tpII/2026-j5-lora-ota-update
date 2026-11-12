/** Warnings for the operator, in Spanish, about the transmit power chosen in a form. */
import type { BoardModel } from "$lib/console/console-event.ts";
import {
  ON_AIR_BANDWIDTH_KILOHERTZ,
  ON_AIR_MAXIMUM_POWER_DBM,
  TRANSCEIVERS,
  TRANSMIT_DUTY_CYCLE_LIMITS,
} from "$lib/protocol/protocol-contract.ts";

/** Warnings about transmitting with `power` dBm on the channels allowed on the air (ADR 0004). */
export function listTransmitPowerWarnings(power: number, model: BoardModel | null): string[] {
  const warnings: string[] = [];
  if (power > ON_AIR_MAXIMUM_POWER_DBM) {
    warnings.push(
      `Por encima de unos ${ON_AIR_MAXIMUM_POWER_DBM} dBm se supera el límite de densidad espectral de los canales de ${ON_AIR_BANDWIDTH_KILOHERTZ} kHz.`,
    );
  }
  if (model === null) {
    return warnings;
  }
  const limits: readonly {
    readonly minimumAntennaDbm: number;
    readonly maximumAntennaDbm: number;
    readonly maximumDutyCyclePercent: number;
  }[] = TRANSMIT_DUTY_CYCLE_LIMITS[model];
  const limit = limits.find(
    (range) => range.minimumAntennaDbm <= power && power <= range.maximumAntennaDbm,
  );
  if (limit !== undefined) {
    warnings.push(
      `A ${power} dBm la hoja de datos del ${TRANSCEIVERS[model]} limita el ciclo de trabajo al ${limit.maximumDutyCyclePercent} %.`,
    );
  }
  return warnings;
}
