import { defineConfig } from 'vite';

// GitHub Pages 项目站点部署在子路径下，base 必须与仓库名一致，
// 否则 dist 里的资源会 404。本地 `npm run preview` 也在同一子路径下验证。
export default defineConfig({
  base: '/storage-ai-radar/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
});
