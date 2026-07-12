import { prisma } from './prisma.js';
import { logger } from './logger.js';

// Ретеншен ПДн (152-ФЗ ст.5 ч.7 — ограничение сроков хранения): обезличиваем технические следы
// (ip_hash / user_agent) в events и audit_logs старше окна. Именно обезличивание, а НЕ удаление —
// аналитические/аудит-события остаются для статистики, но персональные метки стираются.
// Лидов/регистраций эта чистка НЕ трогает (их удаление — отдельная операция с политикой ретеншена).
const IP_HASH_RETENTION_DAYS = 180; // 6 месяцев
const RETENTION_MIN_INTERVAL_MS = 60 * 60 * 1000; // прогон не чаще раза в час

let lastRunAt = 0;

export async function anonymizeExpiredPersonalTraces(now = new Date()) {
  const cutoff = new Date(now.getTime() - IP_HASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const [events, auditLogs] = await Promise.all([
    prisma.event.updateMany({
      where: { createdAt: { lt: cutoff }, ipHash: { not: null } },
      data: { ipHash: null, userAgent: null },
    }),
    prisma.auditLog.updateMany({
      where: { createdAt: { lt: cutoff }, ipHash: { not: null } },
      data: { ipHash: null, userAgent: null },
    }),
  ]);
  return { events: events.count, auditLogs: auditLogs.count };
}

// Троттлированная обёртка для планировщика: тяжёлый scan не чаще раза в час.
export async function runRetentionSweepThrottled(now = new Date()) {
  const ts = now.getTime();
  if (ts - lastRunAt < RETENTION_MIN_INTERVAL_MS) {
    return null;
  }
  lastRunAt = ts;
  const result = await anonymizeExpiredPersonalTraces(now);
  if (result.events || result.auditLogs) {
    logger.info(result, '[ASPБ retention] обезличены устаревшие ip_hash/user_agent');
  }
  return result;
}
