import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": { target: process.env.KOIFORGE_API_PROXY ?? "http://127.0.0.1:3100", changeOrigin: false } },
    port: Number.parseInt(process.env.KOIFORGE_WEB_PORT ?? process.env.PORT ?? '5173', 10),
  },
});
