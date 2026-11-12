import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, lazyPlugins } from "vite-plus";
import panelConfiguration from "./vite.config.ts";

/**
 * Simulation build of the panel: simulation.html, whose entry src/simulation.ts replaces Web Serial
 * and WebSocket with simulated nodes, built into dist-simulation/ for
 * tools/capture_control_panel_screenshots.sh. It leaves out the service worker of the installable
 * application; everything else is the configuration of the panel.
 */
export default defineConfig({
  ...panelConfiguration,
  build: {
    outDir: "dist-simulation",
    rollupOptions: { input: "simulation.html" },
  },
  plugins: lazyPlugins(() => [tailwindcss(), svelte()]),
});
