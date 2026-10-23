import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = `http://127.0.0.1:${process.env.PORT ?? 5757}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 6000 },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": target, "/ws": { target, ws: true } },
  },
});
