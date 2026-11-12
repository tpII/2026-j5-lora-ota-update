import { describe, expect, it } from "vite-plus/test";
import type { RadioSettings } from "./radio-settings.ts";
import {
  describeChannelDifferences,
  formShowsSettings,
  listRadioFormWarnings,
  radioFormChanges,
  radioFormChannel,
  radioFormValuesOf,
} from "./radio-settings-form.ts";

const REPORTED: RadioSettings = {
  freq: 915.9,
  sf: 7,
  bw: 500,
  cr: 5,
  preamble: 8,
  sync: 18,
  power: 4,
  chip: 4,
  lna: "bypass",
};

describe("radioFormChanges", () => {
  it("asks only for the values that differ from the reported settings", () => {
    const values = { ...radioFormValuesOf(REPORTED), sf: 9, power: 10 };
    expect(radioFormChanges(values, REPORTED)).toEqual({ sf: 9, power: 10 });
  });

  it("compares the frequency with the precision the node reports it with", () => {
    const values = { ...radioFormValuesOf(REPORTED), freq: 915.9004 };
    expect(radioFormChanges(values, REPORTED)).toEqual({});
    expect(formShowsSettings(values, REPORTED)).toBe(true);
  });

  it("asks for every value while the node has not reported its settings", () => {
    expect(Object.keys(radioFormChanges(radioFormValuesOf(REPORTED), null))).toEqual([
      "freq",
      "sf",
      "bw",
      "cr",
      "preamble",
      "sync",
      "power",
    ]);
  });
});

describe("formShowsSettings", () => {
  it("tells an edited form from the settings it was loaded with", () => {
    expect(formShowsSettings(radioFormValuesOf(REPORTED), REPORTED)).toBe(true);
    expect(formShowsSettings({ ...radioFormValuesOf(REPORTED), sync: 52 }, REPORTED)).toBe(false);
  });
});

describe("radioFormChannel", () => {
  it("leaves out the power", () => {
    expect(radioFormChannel(radioFormValuesOf(REPORTED))).toEqual({
      freq: 915.9,
      sf: 7,
      bw: 500,
      cr: 5,
      preamble: 8,
      sync: 18,
    });
  });
});

describe("listRadioFormWarnings", () => {
  it("has nothing to say about the defaults", () => {
    expect(listRadioFormWarnings(radioFormValuesOf(REPORTED), "V4.3", "bypass")).toEqual([]);
  });

  it("sends the narrow bandwidths to the bench", () => {
    const values = { ...radioFormValuesOf(REPORTED), bw: 125 };
    expect(listRadioFormWarnings(values, "V2", "bypass")).toEqual([
      "Con antena solo se usan canales de 500 kHz. Los de 125 y 250 kHz son para el banco, con cable coaxial y atenuadores o cargas de 50 Ω.",
    ]);
  });

  it("keeps a 500 kHz channel inside the band", () => {
    const values = { ...radioFormValuesOf(REPORTED), freq: 915.1 };
    expect(listRadioFormWarnings(values, "V2", "bypass")).toEqual([
      "Un canal de 500 kHz va centrado entre 915,25 y 927,75 MHz para quedar dentro de la banda.",
    ]);
  });

  it("warns about an active LNA only on the board that has one", () => {
    const values = radioFormValuesOf(REPORTED);
    expect(listRadioFormWarnings(values, "V2", "on")).toEqual([]);
    expect(listRadioFormWarnings(values, "V4.3", "on")).toHaveLength(1);
  });
});

describe("describeChannelDifferences", () => {
  it("names each channel field that differs, with the value of the other node", () => {
    const other: RadioSettings = { ...REPORTED, freq: 920, cr: 8, sync: 52, power: 20 };
    expect(describeChannelDifferences(REPORTED, other)).toEqual([
      "frecuencia 920,000 MHz",
      "tasa de código 4/8",
      "palabra de sincronismo 52",
    ]);
  });
});
