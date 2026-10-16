import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 开发时：先 `stagent --port 4310` 启动服务，再在 web/ 下 `npx vite`，接口代理到服务。
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:4310' } },
});
