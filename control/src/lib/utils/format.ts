/**
 * Formatting of values for the user interface, in Argentine Spanish: decimal comma, thousands
 * separated with a dot and a space before the unit.
 */
import { formatCodingRate, type RadioSettings } from "$lib/radio/radio-settings.ts";

const LOCALE = "es-AR";

const numberFormats = new Map<number, Intl.NumberFormat>();

function numberFormatWith(decimals: number): Intl.NumberFormat {
  let format = numberFormats.get(decimals);
  if (format === undefined) {
    format = new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    numberFormats.set(decimals, format);
  }
  return format;
}

/** A number with a fixed count of decimals; a dash when there is no value. */
export function formatNumber(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return numberFormatWith(decimals).format(value);
}

export function formatWithUnit(
  value: number | null | undefined,
  decimals: number,
  unit: string,
): string {
  const number = formatNumber(value, decimals);
  return number === "—" ? number : `${number} ${unit}`;
}

export function formatRssi(value: number | null | undefined): string {
  return formatWithUnit(value, 1, "dBm");
}

export function formatSnr(value: number | null | undefined): string {
  return formatWithUnit(value, 2, "dB");
}

export function formatFrequency(megahertz: number | null | undefined): string {
  return formatWithUnit(megahertz, 3, "MHz");
}

/** Packet delivery ratio as a percentage, from a value between 0 and 1. */
export function formatDeliveryRatio(ratio: number | null | undefined): string {
  return ratio === null || ratio === undefined ? "—" : formatWithUnit(ratio * 100, 1, "%");
}

export function formatBitRate(bitsPerSecond: number | null | undefined): string {
  if (bitsPerSecond === null || bitsPerSecond === undefined) {
    return "—";
  }
  if (bitsPerSecond >= 1000) {
    return formatWithUnit(bitsPerSecond / 1000, 2, "kbit/s");
  }
  return formatWithUnit(bitsPerSecond, 0, "bit/s");
}

/** Microseconds shown in milliseconds. */
export function formatMicrosecondsAsMilliseconds(
  microseconds: number | null | undefined,
  decimals = 1,
): string {
  return microseconds === null || microseconds === undefined
    ? "—"
    : formatWithUnit(microseconds / 1000, decimals, "ms");
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** Host time of day with milliseconds, for example 14:03:05,123. */
export function formatClockTime(hostTime: number): string {
  const date = new Date(hostTime);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())},${pad(date.getMilliseconds(), 3)}`;
}

/** Host time of day without milliseconds. */
export function formatShortClockTime(hostTime: number): string {
  const date = new Date(hostTime);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** A duration such as "1 h 05 min", "12 min 30 s" or "45 s". */
export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return "—";
  }
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours} h ${pad(minutes)} min`;
  }
  if (minutes > 0) {
    return `${minutes} min ${pad(seconds)} s`;
  }
  return `${seconds} s`;
}

/** Modulation as SF, bandwidth and coding rate, for example "SF7 · 500 kHz · 4/5". */
export function formatModulation(settings: Pick<RadioSettings, "sf" | "bw" | "cr">): string {
  return `SF${settings.sf} · ${settings.bw} kHz · ${formatCodingRate(settings.cr)}`;
}

/** Sync word in decimal and hexadecimal, for example "18 (0x12)". */
export function formatSyncWord(value: number): string {
  return `${value} (0x${value.toString(16).toUpperCase().padStart(2, "0")})`;
}

export function formatPower(dbm: number | null | undefined): string {
  if (dbm === null || dbm === undefined) {
    return "—";
  }
  return `${dbm > 0 ? "+" : ""}${formatNumber(dbm, 0)} dBm`;
}
