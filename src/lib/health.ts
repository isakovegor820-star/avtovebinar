import { prisma } from './prisma.js';
import { verifyEmailConnectivity } from './email.js';
import { checkTelegramConnectivity } from './telegram.js';

type HealthCheck = {
  ok: boolean;
  error?: string;
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
    await withTimeout(verifyEmailConnectivity(), 3500, 'smtp');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

export async function checkTelegram(): Promise<HealthCheck> {
  try {
    await withTimeout(checkTelegramConnectivity(), 3500, 'telegram');
    return { ok: true };
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
  const [smtp, telegram] = await Promise.all([checkSmtp(), checkTelegram()]);
  const checks = { smtp, telegram };
  return {
    ok: Object.values(checks).every(check => check.ok),
    checks,
  };
}
