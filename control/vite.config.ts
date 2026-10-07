import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, lazyPlugins } from "vite-plus";
import packageManifest from "./package.json" with { type: "json" };

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
  plugins: lazyPlugins(() => [tailwindcss(), svelte()]),
});
