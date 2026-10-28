import { resolve } from "node:path";
import { build } from "vite";

// Keep the background connector self-contained outside macOS-protected
// Documents folders; the installed process does not depend on this checkout.
await build({
  configFile: false,
  publicDir: false,
  ssr: { noExternal: true },
  build: {
    ssr: resolve("connector/cli.ts"),
    target: "node24",
    outDir: resolve(
      process.env.WORKBENCH_CONNECTOR_BUILD_DIR || ".local/connector-build",
    ),
    emptyOutDir: false,
    rolldownOptions: {
      output: { entryFileNames: "connector.mjs", codeSplitting: false },
    },
  },
});
