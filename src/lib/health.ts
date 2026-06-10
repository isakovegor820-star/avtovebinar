import { prisma } from './prisma.js';
import { verifyEmailConnectivity } from './email.js';
import { checkTelegramConnectivity } from './telegram.js';

type HealthCheck = {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
};

function normalizeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function checkDatabase(): Promise<HealthCheck> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 2500, 'database');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

export async function checkSmtp(): Promise<HealthCheck> {
  try {
    const result = await withTimeout(verifyEmailConnectivity(), 3500, 'smtp');
    return { ...result, ok: true };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

export async function checkTelegram(): Promise<HealthCheck> {
  try {
    const result = await withTimeout(checkTelegramConnectivity(), 3500, 'telegram');
    return { ...result, ok: true };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

export async function checkEmailOutbox(): Promise<HealthCheck> {
  try {
    const [pending, failed, sending] = await Promise.all([
      prisma.emailOutboxJob.count({ where: { status: 'pending' } }),
      prisma.emailOutboxJob.count({ where: { status: 'failed', nextAttemptAt: null, sentAt: null } }),
      prisma.emailOutboxJob.count({ where: { status: 'sending', sentAt: null } }),
    ]);
    return { ok: failed === 0, pending, failed, sending };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

export async function getReadiness() {
  const database = await checkDatabase();
  const checks = { database };
  return {
    ok: Object.values(checks).every(check => check.ok),
    checks,
  };
}

export async function getDependencyStatus() {
  const [smtp, telegram, emailOutbox] = await Promise.all([checkSmtp(), checkTelegram(), checkEmailOutbox()]);
  const checks = { smtp, telegram, emailOutbox };
  return {
    ok: Object.values(checks).every(check => check.ok),
    checks,
  };
}
