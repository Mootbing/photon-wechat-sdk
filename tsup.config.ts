import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  // The Spectrum runtime and zod are provided by the host app.
  external: ["@spectrum-ts/core", "@spectrum-ts/core/authoring", "zod"],
});
