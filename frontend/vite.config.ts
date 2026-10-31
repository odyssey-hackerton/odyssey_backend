import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 서버 없이 브라우저에서만 동작하는 프론트다. 백엔드 프록시가 필요 없다.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  preview: { port: 4173 },
});
