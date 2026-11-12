/** The notices the panel shows the operator, and those a radio test asks it to show. */

export type NoticeLevel = "error" | "information";

export interface PanelNotice {
  readonly identifier: number;
  readonly level: NoticeLevel;
  readonly text: string;
}

/** A notice before the panel numbers it. */
export interface SessionNotice {
  readonly level: NoticeLevel;
  readonly text: string;
}
