import { describe, expect, it } from "vite-plus/test";
import {
  capacityTestConfigurationOf,
  capacityTestFormOf,
  parsePayloadSizes,
} from "./capacity-test-form.ts";
import {
  DEFAULT_CAPACITY_TEST_CONFIGURATION,
  validateCapacityTestConfiguration,
} from "./capacity-test-plan.ts";

describe("capacityTestConfigurationOf", () => {
  it("gives back the configuration the form was filled in with", () => {
    expect(
      capacityTestConfigurationOf(capacityTestFormOf(DEFAULT_CAPACITY_TEST_CONFIGURATION)),
    ).toEqual(DEFAULT_CAPACITY_TEST_CONFIGURATION);
  });

  it("orders the bandwidths as the contract does, whatever the order they were checked in", () => {
    const form = { ...capacityTestFormOf(DEFAULT_CAPACITY_TEST_CONFIGURATION) };
    form.bandwidths = [500, 125];
    expect(capacityTestConfigurationOf(form).bandwidths).toEqual([125, 500]);
  });

  it("keeps a reversed range of spreading factors for the validator to report", () => {
    const form = {
      ...capacityTestFormOf(DEFAULT_CAPACITY_TEST_CONFIGURATION),
      firstSpreadingFactor: 12,
      lastSpreadingFactor: 7,
    } as const;
    expect(validateCapacityTestConfiguration(capacityTestConfigurationOf(form))).toEqual([
      "El factor de dispersión inicial no puede superar al final.",
    ]);
  });
});

describe("parsePayloadSizes", () => {
  it("splits on commas, semicolons and spaces", () => {
    expect(parsePayloadSizes(" 16, 64;128  239 ")).toEqual([16, 64, 128, 239]);
  });

  it("keeps a part that is not a number as NaN, which the plan reports out of range", () => {
    expect(parsePayloadSizes("16, x")).toEqual([16, Number.NaN]);
  });
});
