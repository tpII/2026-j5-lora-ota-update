import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA, type VitePWAOptions } from "vite-plugin-pwa";
import { defineConfig, lazyPlugins } from "vite-plus";
import packageManifest from "./package.json" with { type: "json" };

/**
 * Web manifest and service worker of the installable application. The service worker is
 * src/service-worker.ts; the plugin builds it and injects the files of the build it precaches.
 */
const PROGRESSIVE_WEB_APPLICATION_OPTIONS: Partial<VitePWAOptions> = {
  strategies: "injectManifest",
  srcDir: "src",
  filename: "service-worker.ts",
  // A classic script, as the registration expects.
  injectManifest: { rollupFormat: "iife" },
  // A script in the page registers the service worker once it loads, only in the production build.
  injectRegister: "inline",
  manifest: {
    name: "Panel de control J5",
    short_name: "Panel J5",
    description:
      "Panel de control de la red LoRa del grupo J5: consola de los nodos por USB o por WiFi, pruebas de radio y exportación de mediciones.",
    lang: "es-AR",
    dir: "ltr",
    start_url: "./",
    scope: "./",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#0369a1",
    icons: [
      { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  },
};

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths, so the panel works from any directory of the HTTPS host.
  base: "./",
  resolve: {
    // Same alias as SvelteKit: $lib is src/lib. tsconfig.app.json declares it for TypeScript.
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
  },
  define: {
    __PANEL_VERSION__: JSON.stringify(packageManifest.version),
  },
  fmt: {
    ignorePatterns: ["dist/**"],
  },
  lint: {
    ignorePatterns: ["dist/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
  plugins: lazyPlugins(() => [
    tailwindcss(),
    svelte(),
    VitePWA(PROGRESSIVE_WEB_APPLICATION_OPTIONS),
  ]),
});
