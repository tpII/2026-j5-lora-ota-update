/**
 * Registers the service worker that keeps the application shell available without a network, as
 * when the computer is associated with the access point of a node. Only the production build
 * registers it: in development the dev server must serve every request.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return;
  }
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((error: unknown) => {
      console.error("service worker registration failed", error);
    });
  });
}
