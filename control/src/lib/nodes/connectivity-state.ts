/**
 * How a node communicates: its radio settings, whether it sends its HELLO messages and its WiFi
 * access point, from the `radio`, `presence` and `wifi` events.
 */
import type { ConsoleEvent, PresenceState, WifiState } from "$lib/console/console-event.ts";
import { radioSettingsOf, type RadioSettings } from "$lib/radio/radio-settings.ts";

export interface WifiStatus {
  readonly state: WifiState;
  readonly ssid: string;
  readonly channel: number;
  readonly clients: number;
}

/** HELLO messages of the node, from the last `presence` event. */
export interface PresenceStatus {
  readonly state: PresenceState;
  /** Seconds until a hold expires, as the node reported them; null when the HELLO are on. */
  readonly remaining: number | null;
  readonly hostTime: number;
}

export interface ConnectivityState {
  readonly radio: RadioSettings | null;
  readonly wifi: WifiStatus | null;
  readonly presence: PresenceStatus | null;
}

export const INITIAL_CONNECTIVITY_STATE: ConnectivityState = {
  radio: null,
  wifi: null,
  presence: null,
};

export function reduceConnectivity<State extends ConnectivityState>(
  state: State,
  event: ConsoleEvent,
  hostTime: number,
): State {
  switch (event.ev) {
    case "boot":
      // The node always boots with its HELLO messages on.
      return { ...state, presence: { state: "on", remaining: null, hostTime } };
    case "radio":
      return { ...state, radio: radioSettingsOf(event) };
    case "wifi":
      return {
        ...state,
        wifi: {
          state: event.state,
          ssid: event.ssid,
          channel: event.channel,
          clients: event.clients,
        },
      };
    case "presence":
      return {
        ...state,
        presence: { state: event.state, remaining: event.remaining, hostTime },
      };
    default:
      return state;
  }
}
