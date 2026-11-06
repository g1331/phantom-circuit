import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'recover-deferred-panel-imports',
      renderDynamicImport({ moduleId, targetModuleId }) {
        if (
          moduleId.replaceAll('\\', '/').endsWith('/src/web/deferred-panels.tsx') &&
          targetModuleId &&
          /\/(settings-panel|task-detail)\.tsx$/.test(targetModuleId.replaceAll('\\', '/'))
        )
          // Chromium remembers failed module URLs for the document lifetime. Keep the
          // normal cached URL on success; a fresh URL lets an in-place retry recover.
          return {
            left: '(url => import(url).catch(() => import(url + "?retry=" + Date.now())))(',
            right: ')',
          };
      },
    },
  ],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4317' } },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Shared, statically imported runtime. Vite keeps its normal modulepreload behavior.
        manualChunks(id) {
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id.replaceAll('\\', '/')))
            return 'react-vendor';
        },
      },
    },
  },
});
