/**
 * State of a node derived from its event stream, composed of one state per feature, each with its
 * own reducer: the test-run progress and the VM next to their features (measurements/, vm/), the
 * others in nodes/, which the update workflow can import while it reads this composed state. The
 * reducer is pure: every event yields a new state object and leaves the previous one untouched,
 * so views can compare states by reference.
 */
import type { ConsoleEvent } from "$lib/console/console-event.ts";
import {
  INITIAL_TEST_RUN_PROGRESS_STATE,
  reduceTestRunProgress,
  type TestRunProgressState,
} from "$lib/measurements/test-run-progress.ts";
import {
  INITIAL_NODE_UPDATE_STATE,
  reduceNodeUpdate,
  type NodeUpdateState,
} from "$lib/nodes/node-update-state.ts";
import {
  INITIAL_VIRTUAL_MACHINE_STATE,
  reduceVirtualMachine,
  type VirtualMachineState,
} from "$lib/vm/virtual-machine-state.ts";
import {
  INITIAL_CONNECTIVITY_STATE,
  reduceConnectivity,
  type ConnectivityState,
} from "$lib/nodes/connectivity-state.ts";
import {
  INITIAL_ECHO_RECORD_STATE,
  reduceEchoRecords,
  type EchoRecordState,
} from "$lib/nodes/echo-records.ts";
import {
  INITIAL_ERROR_RECORD_STATE,
  reduceErrorRecords,
  type ErrorRecordState,
} from "$lib/nodes/error-records.ts";
import {
  INITIAL_NEIGHBOR_TABLE_STATE,
  reduceNeighborTable,
  type NeighborTableState,
} from "$lib/nodes/neighbor-table.ts";
import {
  INITIAL_NODE_IDENTITY_STATE,
  identifiesAnotherNode,
  reduceNodeIdentity,
  type NodeIdentityState,
} from "$lib/nodes/node-identity.ts";

export interface NodeState
  extends
    NodeIdentityState,
    ConnectivityState,
    NeighborTableState,
    EchoRecordState,
    TestRunProgressState,
    VirtualMachineState,
    NodeUpdateState,
    ErrorRecordState {
  /** Value of `t` and host time of the last event, to estimate the uptime of the node. */
  readonly lastEventNodeTime: number | null;
  readonly lastEventHostTime: number | null;
}

export const INITIAL_NODE_STATE: NodeState = {
  ...INITIAL_NODE_IDENTITY_STATE,
  ...INITIAL_CONNECTIVITY_STATE,
  ...INITIAL_NEIGHBOR_TABLE_STATE,
  ...INITIAL_ECHO_RECORD_STATE,
  ...INITIAL_TEST_RUN_PROGRESS_STATE,
  ...INITIAL_VIRTUAL_MACHINE_STATE,
  ...INITIAL_NODE_UPDATE_STATE,
  ...INITIAL_ERROR_RECORD_STATE,
  lastEventNodeTime: null,
  lastEventHostTime: null,
};

/**
 * Applies one event received at `hostTime` (milliseconds since 1970 on the host). Another node
 * behind the same transport starts the state over; the same node rebooting keeps its history and
 * loses what the firmware loses, as each feature reducer decides on `boot`.
 */
export function applyConsoleEvent(
  state: NodeState,
  event: ConsoleEvent,
  hostTime: number,
): NodeState {
  let next = identifiesAnotherNode(state, event) ? INITIAL_NODE_STATE : state;
  next = reduceNodeIdentity(next, event, hostTime);
  next = reduceConnectivity(next, event, hostTime);
  next = reduceNeighborTable(next, event, hostTime);
  next = reduceEchoRecords(next, event, hostTime);
  next = reduceTestRunProgress(next, event, hostTime);
  next = reduceVirtualMachine(next, event, hostTime);
  next = reduceNodeUpdate(next, event, hostTime);
  next = reduceErrorRecords(next, event, hostTime);
  return { ...next, lastEventNodeTime: event.t, lastEventHostTime: hostTime };
}

/** Uptime of the node at host time `now`, estimated from the `t` of its last event. */
export function estimateUptime(state: NodeState, now: number): number | null {
  if (state.lastEventNodeTime === null || state.lastEventHostTime === null) {
    return null;
  }
  return state.lastEventNodeTime + Math.max(0, now - state.lastEventHostTime);
}
