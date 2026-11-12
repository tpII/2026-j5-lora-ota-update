/**
 * One radio test of the panel from its start until the operator discards its results: the test
 * object, its last snapshot, the connections it was started on and the notices for the operator
 * when it settles. The capacity test, the echo series and both sides of the communication test
 * each live in one session.
 */
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import { describeError } from "$lib/utils/error-description.ts";
import type { NoticeLevel, SessionNotice } from "$lib/state/panel-notice.ts";
import type { RadioTestActivity, SessionTestKind } from "$lib/state/radio-test-activity.ts";

/** What the operator is told when a promise of the test settles. */
export interface SettlementNotices<Snapshot> {
  /** Start of the notice when the promise rejects, such as "La prueba de capacidad falló". */
  readonly failure: string;
  /** Notices for the snapshot the promise resolves with. */
  readonly describe?: (snapshot: Snapshot) => readonly SessionNotice[];
}

export interface RadioTestSessionOptions<Snapshot, Kind extends SessionTestKind> {
  readonly kind: Kind;
  /** True while the test runs, from the status union of its measurement module. */
  readonly isActive: (snapshot: Snapshot) => boolean;
  readonly notify: (level: NoticeLevel, text: string) => void;
}

export class RadioTestSession<Test, Snapshot, Kind extends SessionTestKind = SessionTestKind> {
  readonly kind: Kind;
  /** Last snapshot of the test; null before the first start and after a discard. */
  snapshot = $state.raw<Snapshot | null>(null);
  /** Connections the test was started on, the node it is named after first. */
  keys = $state.raw<readonly string[]>([]);
  /** Identifiers of those nodes, in the same order. */
  nodes = $state.raw<readonly NodeIdentifier[]>([]);

  readonly #isActive: (snapshot: Snapshot) => boolean;
  readonly #notify: (level: NoticeLevel, text: string) => void;
  #test: Test | null = null;

  constructor(options: RadioTestSessionOptions<Snapshot, Kind>) {
    this.kind = options.kind;
    this.#isActive = options.isActive;
    this.#notify = options.notify;
  }

  get test(): Test | null {
    return this.#test;
  }

  get isActive(): boolean {
    return this.snapshot !== null && this.#isActive(this.snapshot);
  }

  /** The activity of the test while it runs, for the exclusion rule; null otherwise. */
  get activity(): RadioTestActivity | null {
    return this.isActive ? { kind: this.kind, keys: this.keys, nodes: this.nodes } : null;
  }

  /** Receives the snapshots of the test; pass it as the `onChange` of the test. */
  readonly publish = (snapshot: Snapshot): void => {
    this.snapshot = snapshot;
  };

  /** Takes a new test, built with `publish` as its `onChange`, and its first snapshot. */
  begin(
    test: Test,
    snapshot: Snapshot,
    keys: readonly string[],
    nodes: readonly NodeIdentifier[],
  ): void {
    this.#test = test;
    this.keys = keys;
    this.nodes = nodes;
    this.snapshot = snapshot;
  }

  /** Tells the operator how `settlement` ended: the notices of its snapshot, or the failure. */
  follow(settlement: Promise<Snapshot>, notices: SettlementNotices<Snapshot>): void {
    settlement.then(
      (snapshot) => {
        for (const notice of notices.describe?.(snapshot) ?? []) {
          this.#notify(notice.level, notice.text);
        }
      },
      (error: unknown) => {
        this.#notify("error", `${notices.failure}: ${describeError(error)}`);
      },
    );
  }

  /** Forgets the results of a test that ended; does nothing while it runs. */
  discard(): void {
    if (!this.isActive) {
      this.#test = null;
      this.snapshot = null;
      this.keys = [];
      this.nodes = [];
    }
  }
}
