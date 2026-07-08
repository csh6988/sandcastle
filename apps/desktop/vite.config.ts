import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev the Electron main process runs the shell server (renderer + board
// proxy) on a fixed port; Vite forwards every /api/* call there so
// the renderer code is identical in dev and packaged modes.
const SHELL_URL = process.env.VITE_SHELL_URL ?? "http://127.0.0.1:4399";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      "/api": { target: SHELL_URL, changeOrigin: true, ws: true },
    },
  },
});
