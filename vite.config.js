import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  root: "demo",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
