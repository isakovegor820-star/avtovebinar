#!/usr/bin/env node
import 'dotenv/config';
import net from 'node:net';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 5174);
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || `http://127.0.0.1:${PORT}`;
const RESTART_DELAY_MS = 1500;
const MIN_STABLE_RUNTIME_MS = 3000;

let child = null;
let stopping = false;
let restartCount = 0;

function log(message) {
  console.log(`[dev] ${message}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      ...options,
    });

    proc.on('error', reject);
    proc.on('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

function isPortAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', error => {
      if (error.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

async function preflight() {
  log('checking webinar video');
  await run('bash', ['scripts/check-video.sh']);

  log('building CSS');
  await run('npm', ['run', 'css:build']);

  log('syncing local Prisma schema');
  await run('npx', ['prisma', 'db', 'push', '--skip-generate']);

  const available = await isPortAvailable(PORT);
  if (!available) {
    throw new Error(`Port ${PORT} is already in use. Stop the old dev server or set PORT to a free value in .env.`);
  }
}

function startWatcher() {
  const startedAt = Date.now();
  log(`starting backend on ${PUBLIC_SITE_URL}`);
  child = spawn('npx', ['tsx', 'watch', 'src/server.ts'], {
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_SITE_URL,
    },
  });

  child.on('error', error => {
    console.error('[dev] failed to start tsx watcher:', error);
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping || signal === 'SIGINT' || signal === 'SIGTERM') {
      process.exit(code ?? 0);
    }

    const runtimeMs = Date.now() - startedAt;
    if (code !== 0 && runtimeMs < MIN_STABLE_RUNTIME_MS) {
      console.error(
        `[dev] backend exited during startup with code ${code}. Fix the error above and run npm run dev again.`,
      );
      process.exit(code ?? 1);
    }

    restartCount += 1;
    console.error(
      `[dev] backend watcher stopped unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}). Restarting #${restartCount} in ${RESTART_DELAY_MS}ms...`,
    );
    setTimeout(startWatcher, RESTART_DELAY_MS);
  });
}

function stop(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  log(`received ${signal}, stopping dev server`);
  if (child) {
    child.kill(signal);
    setTimeout(() => {
      if (child) {
        child.kill('SIGKILL');
      }
    }, 3000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

try {
  await preflight();
  startWatcher();
} catch (error) {
  console.error('[dev] startup failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
