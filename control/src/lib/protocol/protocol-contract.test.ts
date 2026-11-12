import { describe, expect, it } from "vite-plus/test";
import responseDeadlineVectors from "../../../../firmware/protocol/test-vectors/response-deadlines.json";
import {
  findStaleDocumentMentions,
  findStaleProtocolSources,
} from "../../../../tools/generate_protocol_sources.mjs";
import {
  echoLossDeadlineMilliseconds,
  runReceptionDeadlineMilliseconds,
} from "./protocol-contract.ts";

describe("protocol contract", () => {
  it("has its generated sources up to date with firmware/protocol/contract.json and the test vectors", () => {
    // Covers protocol-contract.ts and the two firmware headers. On failure, run
    // node tools/generate_protocol_sources.mjs from the repository root.
    expect(findStaleProtocolSources()).toEqual([]);
  });

  it("has the values that the documents repeat up to date with the contract", () => {
    expect(findStaleDocumentMentions()).toEqual([]);
  });
});

describe("response deadlines", () => {
  // The cases that the firmware host tests check too.
  it.each(responseDeadlineVectors.echoLossDeadlineMilliseconds)(
    "gives the echo_lost deadline of the shared vector for a request of $requestTimeOnAirMicroseconds µs",
    (vector) => {
      expect(echoLossDeadlineMilliseconds(vector.requestTimeOnAirMicroseconds)).toBe(
        vector.expectedMilliseconds,
      );
    },
  );

  it.each(responseDeadlineVectors.runReceptionDeadlineMilliseconds)(
    "gives the run_end deadline of the shared vector for $intervalMilliseconds ms and a packet of $packetTimeOnAirMicroseconds µs",
    (vector) => {
      expect(
        runReceptionDeadlineMilliseconds(
          vector.intervalMilliseconds,
          vector.packetTimeOnAirMicroseconds,
        ),
      ).toBe(vector.expectedMilliseconds);
    },
  );
});
