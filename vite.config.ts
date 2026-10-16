import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The production server serves ../server/client-dist statically.
// base "./" keeps asset paths relative so the build works under any mount path.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
  build: {
    outDir: "../server/client-dist",
    emptyOutDir: true,
  },
});
