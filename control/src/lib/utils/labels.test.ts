import { describe, expect, it } from "vite-plus/test";
import { describeErrorReason } from "./labels.ts";

describe("describeErrorReason", () => {
  it("describes the reasons of the contract and admits the ones it does not know", () => {
    expect(describeErrorReason("busy")).toBe("hay una corrida o un eco en curso");
    expect(describeErrorReason("wifi_failure")).toBe("no se pudo encender el punto de acceso");
    expect(describeErrorReason("thermal_limit")).toBe("motivo que este panel no conoce");
  });
});
