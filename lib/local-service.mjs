// lib/local-service.mjs: safety helpers for a scraper we start on this machine.
import net from 'net';
import { execFileSync } from 'child_process';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True when the URL points at this machine only. */
export function isLoopback(url) {
  try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; }
}

/** True when nothing is listening on 127.0.0.1:port. */
export function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** Run `fn` once on exit, Ctrl-C, SIGTERM or a crash. Returns a function that runs it now and disarms the hooks. */
export function onShutdown(fn) {
  let done = false;
  const run = () => { if (done) return; done = true; try { fn(); } catch { /* best effort */ } };
  const bySignal = (sig) => () => { run(); process.exit(sig === 'SIGINT' ? 130 : 143); };
  const sigint = bySignal('SIGINT');
  const sigterm = bySignal('SIGTERM');
  const crash = (err) => { run(); console.error('Fatal:', err?.stack || err); process.exit(1); };
  process.on('exit', run);
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  return () => {
    run();
    process.off('exit', run);
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    process.off('uncaughtException', crash);
    process.off('unhandledRejection', crash);
  };
}

/** HEAD commit of a git checkout, or null. */
export function gitHead(dir) {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; }
}
