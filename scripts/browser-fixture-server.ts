import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createHTTPServer, request as httpRequest } from 'node:http';
import { createServer as createPortProbe, type AddressInfo, type Socket } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { chromium, type Browser } from 'playwright';

// Chromium refuses some ports outright (net::ERR_UNSAFE_PORT); those above 1024 are skipped.
const unsafePorts = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
]);

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Pick an ephemeral loopback port that Chromium permits. */
export async function freePort(): Promise<number> {
  const port = await new Promise<number>((done, fail) => {
    const probe = createPortProbe().once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as AddressInfo;
      probe.close((error) => (error ? fail(error) : done(address.port)));
    });
  });
  return unsafePorts.has(port) ? freePort() : port;
}

/**
 * Serve the built `dist/` bundle directly for browser checks, avoiding per-check Vite dev server
 * startup and module compilation while optionally proxying `/api/*` to a separate backend origin.
 */
export async function serveDist(options: { port?: number; apiTarget?: string } = {}) {
  const distDir = resolve('dist');
  const indexHtml = join(distDir, 'index.html');
  if (!existsSync(indexHtml)) {
    throw new Error('Missing dist/index.html — run "npm run build" before running browser checks.');
  }
  const port = options.port ?? (await freePort());
  const apiUrl = options.apiTarget ? new URL(options.apiTarget) : undefined;
  const sockets = new Set<Socket>();
  const server = createHTTPServer(async (req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0];
    if (apiUrl && (urlPath === '/api' || urlPath.startsWith('/api/'))) {
      const headers = { ...req.headers, host: apiUrl.host, origin: apiUrl.origin };
      const proxyReq = httpRequest(
        {
          hostname: apiUrl.hostname,
          port: apiUrl.port,
          path: req.url,
          method: req.method,
          headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
          proxyRes.on('aborted', () => res.destroy());
        },
      );
      proxyReq.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Upstream unavailable' }));
        } else {
          res.destroy();
        }
      });
      req.pipe(proxyReq);
      return;
    }
    const clean = decodeURIComponent(urlPath).replace(/^\/+/, '');
    const candidate = clean ? resolve(distDir, clean) : indexHtml;
    const target =
      candidate === indexHtml || candidate.startsWith(distDir + sep) ? candidate : indexHtml;
    let filePath = target;
    let body: Buffer;
    try {
      body = await readFile(filePath);
    } catch {
      filePath = indexHtml;
      body = await readFile(indexHtml);
    }
    res.writeHead(200, {
      'content-type': mimeTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    });
    res.end(body);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => done());
  });
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done, fail) =>
        server.close((error) => (error ? fail(error) : done())),
      );
    },
  };
}

/** Reuse a shared Playwright Browser when provided, or launch and own one for standalone runs. */
export async function acquireBrowser(sharedBrowser?: Browser) {
  if (sharedBrowser) {
    return { browser: sharedBrowser, release: async () => {} };
  }
  const browser = await chromium.launch({
    headless: true,
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  return {
    browser,
    release: () => browser.close(),
  };
}

/** Run independent async jobs with a bounded concurrency limit. */
export async function runConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}
