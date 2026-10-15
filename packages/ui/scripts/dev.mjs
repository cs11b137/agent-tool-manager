import { createServer } from 'vite';
import { startServer } from '../../server/dist/index.js';

// Real local data is the default. Demo mode has a separate dev:mock command.
process.env.VITE_ATM_MOCK = '0';
const backend = await startServer();
const backendOrigin = new URL(backend.url).origin;
let frontend;
let closing;
const close = () => closing ??= (async () => {
  await frontend?.close();
  await backend.close();
})();
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

try {
  frontend = await createServer({
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: backendOrigin,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReq', (proxyReq, req) => {
              // Preserve foreign Origins for the backend's CSRF rejection.
              // Authentication headers and SSE query tokens pass through unchanged.
              if (req.headers.origin === 'http://127.0.0.1:5173' || req.headers.origin === 'http://localhost:5173') {
                proxyReq.setHeader('Origin', backendOrigin);
              }
            });
          },
        },
      },
    },
  });
  await frontend.listen();
  const url = new URL('http://127.0.0.1:5173');
  url.searchParams.set('token', backend.token);
  console.log(`\n真实数据 · ${url}\n按 Ctrl+C 停止前端与 API 服务。\n`);
} catch (error) {
  await close();
  throw error;
}
