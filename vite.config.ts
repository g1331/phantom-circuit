import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
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
