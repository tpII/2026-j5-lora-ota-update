/**
 * Service worker of the control panel. It keeps the application shell available without a network,
 * as when the computer is associated with the access point of a node (ADR 0002). vite-plugin-pwa
 * builds it and injects the files to precache: the page, its hashed assets, the manifest and the
 * icons.
 *
 * - A navigation goes to the network first, with a short deadline, and falls back to the precached
 *   page, so the panel shows the latest version whenever the host is reachable.
 * - The other precached files come from the precache, which a new build replaces.
 * - Requests to other origins and WebSocket connections never pass through it.
 */
import { clientsClaim } from "workbox-core";
import {
  PrecacheFallbackPlugin,
  addRoute,
  cleanupOutdatedCaches,
  precache,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkOnly } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope;

/** Without an answer from the network within this time, a navigation gets the precached page. */
const NAVIGATION_NETWORK_TIMEOUT_SECONDS = 3;

void self.skipWaiting();
clientsClaim();

precache(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Registered before the precache route, so that the precache never answers a navigation.
registerRoute(
  new NavigationRoute(
    new NetworkOnly({
      networkTimeoutSeconds: NAVIGATION_NETWORK_TIMEOUT_SECONDS,
      plugins: [new PrecacheFallbackPlugin({ fallbackURL: "index.html" })],
    }),
  ),
);
addRoute();
