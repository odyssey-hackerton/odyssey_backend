import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 개발 중 /api 요청을 보낼 백엔드 주소.
//   로컬 백엔드:  npm run dev
//   서버 백엔드:  VITE_API_TARGET=http://10.1.1.27 npm run dev   (VPN 연결 필요)
const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:8000";

const proxy = {
  "/api": { target: apiTarget, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  // 첫 텍스트제거 선택 때 의존성 최적화로 페이지가 새로고침되지 않게 한다.
  optimizeDeps: { include: ["@techstark/opencv-js"] },
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
});
