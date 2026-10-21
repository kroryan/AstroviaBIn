import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync } from "fs";

const { version } = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "package.json"), "utf8")) as { version: string };

export default defineConfig({
  // The client compares this with the server's version to notice a page left open across an update.
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "apps/client", "src"),
      "@shared": path.resolve(import.meta.dirname, "packages/shared/src"),
      "@assets": path.resolve(import.meta.dirname, "assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "apps/client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:5000',
        ws: true,
      },
    },
  },
});
