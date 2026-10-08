/**
 * Radio settings the panel offers as buttons, one click per change. Each button sends the `radio`
 * command for a single setting, the same line the form or the console would send. The values work
 * on both board models and stay away from their limits; the form keeps the full ranges.
 */
import type { RadioSettingChanges } from "$lib/console/console-command.ts";
import type { BoardModel } from "$lib/console/console-event.ts";
import { formatPower, formatWithUnit } from "$lib/utils/format.ts";
import {
  BANDWIDTHS_KILOHERTZ,
  CODING_RATE_DENOMINATORS,
  ON_AIR_BANDWIDTH_KILOHERTZ,
  SPREADING_FACTORS,
  formatCodingRate,
  frequenciesMatch,
  hasLowNoiseAmplifier,
  type RadioSettings,
} from "./radio-settings.ts";

/**
 * Powers at the antenna connector, in dBm. 4 dBm is the lowest power of the V4.3 and 17 dBm the
 * highest power of the V2 without the 1 % duty cycle that 20 dBm imposes; on the V4.3 it stays
 * 11 dB under its maximum and under the limit of the 500 kHz channels.
 */
export const QUICK_TRANSMIT_POWERS_DBM = [4, 7, 10, 14, 17] as const;

/**
 * Centers of the AU915 500 kHz uplink channels 64, 66, 67 and 68, in MHz. Channel 65 belongs to
 * sub-band 2, the one The Things Network uses, and from channel 69 on they overlap the downlink
 * channels.
 */
export const QUICK_FREQUENCIES_MEGAHERTZ = [915.9, 919.1, 920.7, 922.3] as const;

const BENCH_BANDWIDTH_WARNING =
  "Los canales de 125 y 250 kHz son solo para el banco, con cable coaxial y atenuadores o cargas de 50 Ω (ADR 0004).";

const LOW_NOISE_AMPLIFIER_NOTE =
  "El botón Activo está deshabilitado: con el LNA activo, una señal de más de unos −21 dBm en la antena satura el SX1262 y puede dañarlo. El LNA se activa desde el formulario.";

export interface QuickRadioOption {
  /** The single setting the button changes. */
  readonly changes: RadioSettingChanges;
  readonly label: string;
  /** Risk the operator confirms before the change; null when the value carries none. */
  readonly warning: string | null;
  /** False for a button that is shown but never sends its command. */
  readonly enabled: boolean;
}

export interface QuickRadioGroup {
  readonly label: string;
  readonly options: readonly QuickRadioOption[];
  /** Explanation shown under the buttons; null when the group needs none. */
  readonly note: string | null;
}

function safeOption(changes: RadioSettingChanges, label: string): QuickRadioOption {
  return { changes, label, warning: null, enabled: true };
}

/** The buttons of each setting, in the order of docs/protocol/radio.md. */
export function listQuickRadioGroups(model: BoardModel | null): QuickRadioGroup[] {
  const groups: QuickRadioGroup[] = [
    {
      label: "Frecuencia",
      options: QUICK_FREQUENCIES_MEGAHERTZ.map((freq) =>
        safeOption({ freq }, formatWithUnit(freq, 1, "MHz")),
      ),
      note: null,
    },
    {
      label: "Factor de dispersión",
      options: SPREADING_FACTORS.map((sf) => safeOption({ sf }, `SF${sf}`)),
      note: null,
    },
    {
      label: "Ancho de banda",
      options: BANDWIDTHS_KILOHERTZ.map((bw) => ({
        ...safeOption({ bw }, `${bw} kHz`),
        warning: bw === ON_AIR_BANDWIDTH_KILOHERTZ ? null : BENCH_BANDWIDTH_WARNING,
      })),
      note: null,
    },
    {
      label: "Tasa de código",
      options: CODING_RATE_DENOMINATORS.map((cr) => safeOption({ cr }, formatCodingRate(cr))),
      note: null,
    },
    {
      label: "Potencia en la antena",
      options: QUICK_TRANSMIT_POWERS_DBM.map((power) => safeOption({ power }, formatPower(power))),
      note: null,
    },
  ];
  if (hasLowNoiseAmplifier(model)) {
    // Bypass stays available: it is the safe mode and undoes an activation made from the form.
    groups.push({
      label: "LNA de la V4.3",
      options: [
        safeOption({ lna: "bypass" }, "Puenteado"),
        { ...safeOption({ lna: "on" }, "Activo"), enabled: false },
      ],
      note: LOW_NOISE_AMPLIFIER_NOTE,
    });
  }
  return groups;
}

/** True when the node already uses the value of the option. */
export function isQuickOptionCurrent(
  option: QuickRadioOption,
  settings: RadioSettings | null,
): boolean {
  if (settings === null) {
    return false;
  }
  const { freq, sf, bw, cr, preamble, sync, power, lna } = option.changes;
  return (
    (freq === undefined || frequenciesMatch(freq, settings.freq)) &&
    (sf === undefined || sf === settings.sf) &&
    (bw === undefined || bw === settings.bw) &&
    (cr === undefined || cr === settings.cr) &&
    (preamble === undefined || preamble === settings.preamble) &&
    (sync === undefined || sync === settings.sync) &&
    (power === undefined || power === settings.power) &&
    (lna === undefined || lna === settings.lna)
  );
}
