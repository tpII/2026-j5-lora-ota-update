/**
 * Setup of every panel test (vite.config.ts): after each test, the lines that the simulated nodes
 * of the test wrote must have the field sets that the firmware writes for each event.
 */
import { afterEach, expect } from "vite-plus/test";
import { findShapeDeviations } from "./firmware-event-shapes.ts";
import { observeSimulatedNodeCreation, type SimulatedNode } from "./simulated-node.ts";

const nodesOfTest: SimulatedNode[] = [];
observeSimulatedNodeCreation((node) => nodesOfTest.push(node));

afterEach(() => {
  const lines = nodesOfTest.splice(0).flatMap((node) => node.emittedLines);
  expect(findShapeDeviations(lines)).toEqual([]);
});
