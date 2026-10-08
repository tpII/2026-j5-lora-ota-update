import { describe, expect, it } from "vite-plus/test";
import { buildRadioSetCommand } from "$lib/console/console-command.ts";
import type { BoardModel } from "$lib/console/console-event.ts";
import {
  QUICK_FREQUENCIES_MEGAHERTZ,
  QUICK_TRANSMIT_POWERS_DBM,
  isQuickOptionCurrent,
  listQuickRadioGroups,
  type QuickRadioOption,
} from "./radio-presets.ts";
import {
  DEFAULT_RADIO_SETTINGS,
  ON_AIR_MAXIMUM_CENTER_MEGAHERTZ,
  ON_AIR_MAXIMUM_POWER_DBM,
  ON_AIR_MINIMUM_CENTER_MEGAHERTZ,
  TRANSMIT_POWER_RANGES,
  type RadioSettings,
} from "./radio-settings.ts";

const MODELS: readonly (BoardModel | null)[] = ["V2", "V4.3", null];

const DEFAULT_SETTINGS: RadioSettings = { ...DEFAULT_RADIO_SETTINGS, chip: -9 };

function optionsOf(model: BoardModel | null): QuickRadioOption[] {
  return listQuickRadioGroups(model).flatMap((group) => group.options);
}

function optionWith(model: BoardModel | null, label: string): QuickRadioOption {
  const option = optionsOf(model).find((candidate) => candidate.label === label);
  if (option === undefined) {
    throw new Error(`No button labelled ${label}`);
  }
  return option;
}

describe("listQuickRadioGroups", () => {
  it("builds a valid radio command with a single setting for every button", () => {
    for (const model of MODELS) {
      for (const option of optionsOf(model)) {
        expect(Object.keys(option.changes)).toHaveLength(1);
        expect(buildRadioSetCommand(option.changes, model).valid).toBe(true);
      }
    }
    expect(buildRadioSetCommand(optionWith("V4.3", "SF9").changes, "V4.3")).toEqual({
      valid: true,
      command: "radio sf 9",
    });
  });

  it("keeps the transmit power inside the continuous range of both board models", () => {
    for (const power of QUICK_TRANSMIT_POWERS_DBM) {
      for (const range of Object.values(TRANSMIT_POWER_RANGES)) {
        expect(power).toBeGreaterThanOrEqual(range.minimum);
        expect(power).toBeLessThanOrEqual(range.maximum);
      }
      expect(power).toBeLessThan(ON_AIR_MAXIMUM_POWER_DBM);
    }
  });

  it("offers frequencies whose 500 kHz channel fits in the band", () => {
    for (const frequency of QUICK_FREQUENCIES_MEGAHERTZ) {
      expect(frequency).toBeGreaterThanOrEqual(ON_AIR_MINIMUM_CENTER_MEGAHERTZ);
      expect(frequency).toBeLessThanOrEqual(ON_AIR_MAXIMUM_CENTER_MEGAHERTZ);
    }
  });

  it("offers the LNA only on the V4.3", () => {
    expect(optionsOf("V2").some((option) => option.changes.lna !== undefined)).toBe(false);
    expect(optionsOf(null).some((option) => option.changes.lna !== undefined)).toBe(false);
    expect(optionsOf("V4.3").filter((option) => option.changes.lna !== undefined)).toHaveLength(2);
  });

  it("asks for confirmation only for the bench bandwidths", () => {
    const confirmed = optionsOf("V4.3")
      .filter((option) => option.warning !== null)
      .map((option) => option.changes);
    expect(confirmed).toEqual([{ bw: 125 }, { bw: 250 }]);
  });

  it("shows the button that activates the LNA but keeps it disabled", () => {
    const disabled = optionsOf("V4.3")
      .filter((option) => !option.enabled)
      .map((option) => option.changes);
    expect(disabled).toEqual([{ lna: "on" }]);
    const lowNoiseAmplifier = listQuickRadioGroups("V4.3").find(
      (group) => group.label === "LNA de la V4.3",
    );
    expect(lowNoiseAmplifier?.note).toContain("deshabilitado");
  });
});

describe("isQuickOptionCurrent", () => {
  it("marks the values the node reports", () => {
    const current = optionsOf("V4.3")
      .filter((option) => isQuickOptionCurrent(option, DEFAULT_SETTINGS))
      .map((option) => option.label);
    expect(current).toEqual(["915,9 MHz", "SF7", "500 kHz", "4/5", "+4 dBm", "Puenteado"]);
  });

  it("compares the frequency with the precision the firmware reports", () => {
    const option = optionWith("V2", "919,1 MHz");
    expect(isQuickOptionCurrent(option, { ...DEFAULT_SETTINGS, freq: 919.1004 })).toBe(true);
    expect(isQuickOptionCurrent(option, { ...DEFAULT_SETTINGS, freq: 919.102 })).toBe(false);
  });

  it("marks nothing while the settings are unknown", () => {
    expect(optionsOf("V4.3").some((option) => isQuickOptionCurrent(option, null))).toBe(false);
  });
});
