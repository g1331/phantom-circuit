import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';
import { CONFIG_FILE_NAME, DATA_DIRECTORY_NAME } from './src/server/data-directory.ts';

export async function developmentPort(dataDir = join(homedir(), DATA_DIRECTORY_NAME)) {
  try {
    const configPath = join(dataDir, CONFIG_FILE_NAME);
    return z
      .object({ port: z.number().int().min(1024).max(65535) })
      .parse(JSON.parse(await readFile(configPath, 'utf8'))).port;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 4317;
    throw error;
  }
}

export default defineConfig(async ({ command }): Promise<UserConfig> => ({
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
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${
        command === 'serve'
          ? await developmentPort(process.env.PHANTOM_DEV_DATA_DIR || undefined)
          : 4317
      }`,
    },
  },
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
}));
