import { describe, expect, it } from "vite-plus/test";
import {
  readCommunicationTestForm,
  type CommunicationTestForm,
} from "./communication-test-form.ts";

const FORM: CommunicationTestForm = { sf: 7, bw: 500, cr: 5, count: 100, destination: " 5c21" };

describe("readCommunicationTestForm", () => {
  it("reads the modulation, the count and the destination as the console takes it", () => {
    expect(readCommunicationTestForm(FORM, "3A7F", 8)).toEqual({
      configuration: { sf: 7, bw: 500, cr: 5, count: 100 },
      destination: "5C21",
      destinationProblem: null,
      problems: [],
    });
  });

  it("rejects the node itself as the destination", () => {
    const request = readCommunicationTestForm({ ...FORM, destination: "3a7f" }, "3A7F", 8);
    expect(request.destinationProblem).toBe("El destino tiene que ser otro nodo.");
    expect(request.problems).toEqual(["El destino tiene que ser otro nodo."]);
  });

  it("puts the problems of the configuration before the one of the destination", () => {
    const request = readCommunicationTestForm({ ...FORM, count: 0, destination: "" }, "3A7F", 8);
    expect(request.problems).toEqual([
      "La cantidad de ecos va de 1 a 1000.",
      "El destino es un identificador de 4 dígitos hexadecimales, distinto de 0000 y FFFF.",
    ]);
  });
});
