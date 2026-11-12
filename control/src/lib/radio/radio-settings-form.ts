/**
 * The radio settings form of one node: the values it holds, the changes it asks the node for, the
 * warnings it shows about the channel chosen and the words with which the panel tells how the
 * channel of another node differs.
 */
import type { BoardModel, LnaMode } from "$lib/console/console-event.ts";
import {
  ON_AIR_BANDWIDTH_KILOHERTZ,
  ON_AIR_MAXIMUM_CENTER_MEGAHERTZ,
  ON_AIR_MINIMUM_CENTER_MEGAHERTZ,
} from "$lib/protocol/protocol-contract.ts";
import {
  BENCH_BANDWIDTHS_KILOHERTZ,
  CHANNEL_FIELDS,
  differingSettings,
  hasLowNoiseAmplifier,
  settingsMatch,
  type RadioSettingChanges,
  type RadioSettings,
} from "$lib/radio/radio-settings.ts";
import {
  formatCodingRate,
  formatConjunction,
  formatFrequency,
  formatLimit,
} from "$lib/utils/format.ts";
import { listTransmitPowerWarnings } from "./transmit-power-warnings.ts";

/**
 * What the form edits: every setting of the `radio` command but the LNA mode, which only the
 * console changes.
 */
export const RADIO_FORM_FIELDS = [...CHANNEL_FIELDS, "power"] as const;

export type RadioFormField = (typeof RADIO_FORM_FIELDS)[number];

export type RadioFormValues = { [Field in RadioFormField]: RadioSettings[Field] };

type ChannelField = (typeof CHANNEL_FIELDS)[number];

export function radioFormValuesOf(settings: RadioFormValues): RadioFormValues {
  const { freq, sf, bw, cr, preamble, sync, power } = settings;
  return { freq, sf, bw, cr, preamble, sync, power };
}

/** True while the form holds `settings` as they were loaded, without edits. */
export function formShowsSettings(values: RadioFormValues, settings: RadioSettings): boolean {
  return settingsMatch(values, settings, RADIO_FORM_FIELDS);
}

/**
 * The values that differ from the settings the node reports, or all of them when it reported none.
 */
export function radioFormChanges(
  values: RadioFormValues,
  current: RadioSettings | null,
): RadioSettingChanges {
  const fields =
    current === null ? RADIO_FORM_FIELDS : differingSettings(values, current, RADIO_FORM_FIELDS);
  return Object.fromEntries(fields.map((field) => [field, values[field]]));
}

/**
 * The channel of the form, which «Copiar el canal a los demás nodos» sends: no power and no LNA.
 */
export function radioFormChannel(values: RadioFormValues): RadioSettingChanges {
  return Object.fromEntries(CHANNEL_FIELDS.map((field) => [field, values[field]]));
}

/**
 * Warnings about using the values of the form with an antenna (ADR 0004) and about the LNA of the
 * board, which `lna` gives as the node reports it.
 */
export function listRadioFormWarnings(
  values: RadioFormValues,
  model: BoardModel | null,
  lna: LnaMode,
): string[] {
  const warnings: string[] = [];
  if (values.bw !== ON_AIR_BANDWIDTH_KILOHERTZ) {
    warnings.push(
      `Con antena solo se usan canales de ${ON_AIR_BANDWIDTH_KILOHERTZ} kHz. Los de ${formatConjunction(BENCH_BANDWIDTHS_KILOHERTZ.map(String))} kHz son para el banco, con cable coaxial y atenuadores o cargas de 50 Ω.`,
    );
  } else if (
    values.freq < ON_AIR_MINIMUM_CENTER_MEGAHERTZ ||
    values.freq > ON_AIR_MAXIMUM_CENTER_MEGAHERTZ
  ) {
    warnings.push(
      `Un canal de ${ON_AIR_BANDWIDTH_KILOHERTZ} kHz va centrado entre ${formatLimit(ON_AIR_MINIMUM_CENTER_MEGAHERTZ, 2)} y ${formatLimit(ON_AIR_MAXIMUM_CENTER_MEGAHERTZ, 2)} MHz para quedar dentro de la banda.`,
    );
  }
  warnings.push(...listTransmitPowerWarnings(values.power, model));
  if (hasLowNoiseAmplifier(model) && lna === "on") {
    warnings.push(
      "Con el LNA activo, una señal de más de unos −21 dBm en la antena satura el SX1262 y puede dañarlo: sobre la mesa debe quedar puenteado.",
    );
  }
  return warnings;
}

const CHANNEL_DIFFERENCE_DESCRIPTIONS: {
  readonly [Field in ChannelField]: (settings: RadioSettings) => string;
} = {
  freq: (settings) => `frecuencia ${formatFrequency(settings.freq)}`,
  sf: (settings) => `SF${settings.sf}`,
  bw: (settings) => `${settings.bw} kHz`,
  cr: (settings) => `tasa de código ${formatCodingRate(settings.cr)}`,
  preamble: (settings) => `preámbulo de ${settings.preamble} símbolos`,
  sync: (settings) => `palabra de sincronismo ${settings.sync}`,
};

/** The channel fields in which `other` differs from `reference`, with the values of `other`. */
export function describeChannelDifferences(
  reference: RadioSettings,
  other: RadioSettings,
): string[] {
  return differingSettings(reference, other, CHANNEL_FIELDS).map((field) =>
    CHANNEL_DIFFERENCE_DESCRIPTIONS[field](other),
  );
}
