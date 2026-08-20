import type { NextFunction, Request, Response } from 'express';
import { prisma } from './prisma.js';

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type RouteStats = {
  count: number;
  errors: number;
  sum: number;
  buckets: number[];
};

const requestStats = new Map<string, RouteStats>();

function routeKey(req: Request) {
  // Низкую кардинальность дают только сматченные маршруты. Для 404/несматченных НЕ берём
  // req.path (произвольный ввод) — иначе неограниченный рост памяти/кардинальности и инъекция лейбла.
  if (!req.route?.path) {
    return `${req.method} <unmatched>`;
  }
  return `${req.method} ${req.baseUrl + req.route.path}`;
}

function getStats(key: string) {
  const existing = requestStats.get(key);
  if (existing) {
    return existing;
  }
  const stats = { count: 0, errors: 0, sum: 0, buckets: buckets.map(() => 0) };
  requestStats.set(key, stats);
  return stats;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    const key = routeKey(req);
    const stats = getStats(key);
    stats.count += 1;
    stats.sum += durationSeconds;
    if (res.statusCode >= 500) {
      stats.errors += 1;
    }
    buckets.forEach((bucket, index) => {
      if (durationSeconds <= bucket) {
        stats.buckets[index] += 1;
      }
    });
  });
  next();
}

function metricLine(name: string, labels: Record<string, string>, value: number) {
  const labelText = Object.entries(labels)
    .map(([key, labelValue]) => {
      // Экранирование по правилам Prometheus: сначала \, затем ", затем перевод строки.
      const escaped = String(labelValue).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
      return `${key}="${escaped}"`;
    })
    .join(',');
  return `${name}{${labelText}} ${value}`;
}

export async function renderPrometheusMetrics() {
  const lines: string[] = [];
  lines.push('# HELP aspb_http_requests_total Total HTTP requests.');
  lines.push('# TYPE aspb_http_requests_total counter');
  lines.push('# HELP aspb_http_request_errors_total Total HTTP 5xx responses.');
  lines.push('# TYPE aspb_http_request_errors_total counter');
  lines.push('# HELP aspb_http_request_duration_seconds HTTP request duration.');
  lines.push('# TYPE aspb_http_request_duration_seconds histogram');

  let totalRequests = 0;
  let totalErrors = 0;
  for (const [route, stats] of requestStats.entries()) {
    totalRequests += stats.count;
    totalErrors += stats.errors;
    lines.push(metricLine('aspb_http_requests_total', { route }, stats.count));
    lines.push(metricLine('aspb_http_request_errors_total', { route }, stats.errors));
    buckets.forEach((bucket, index) => {
      lines.push(
        metricLine('aspb_http_request_duration_seconds_bucket', { route, le: String(bucket) }, stats.buckets[index]),
      );
    });
    lines.push(metricLine('aspb_http_request_duration_seconds_bucket', { route, le: '+Inf' }, stats.count));
    lines.push(metricLine('aspb_http_request_duration_seconds_sum', { route }, Number(stats.sum.toFixed(6))));
    lines.push(metricLine('aspb_http_request_duration_seconds_count', { route }, stats.count));
  }

  const [
    emailPending,
    emailFailed,
    userAuthEmailPending,
    userAuthEmailFailed,
    userAuthEmailDeadLetters,
    invitationEmailPending,
    invitationEmailFailed,
    invitationEmailDeadLetters,
    broadcastPending,
    broadcastDeadLetters,
  ] = await Promise.all([
    prisma.emailOutboxJob.count({ where: { status: { in: ['pending', 'failed', 'sending'] }, sentAt: null } }),
    prisma.emailOutboxJob.count({ where: { status: 'failed', sentAt: null } }),
    prisma.userAuthEmailJob.count({ where: { status: { in: ['PENDING', 'FAILED', 'SENDING'] } } }),
    prisma.userAuthEmailJob.count({ where: { status: 'FAILED' } }),
    prisma.userAuthEmailJob.count({ where: { status: 'DEAD_LETTER' } }),
    prisma.organizationInvitationEmailJob.count({ where: { status: { in: ['PENDING', 'FAILED', 'SENDING'] } } }),
    prisma.organizationInvitationEmailJob.count({ where: { status: 'FAILED' } }),
    prisma.organizationInvitationEmailJob.count({ where: { status: 'DEAD_LETTER' } }),
    prisma.telegramBroadcastJob.count({
      where: { status: { in: ['pending', 'failed', 'sending'] }, completedAt: null },
    }),
    prisma.telegramBroadcastDeadLetter.count(),
  ]);

  const errorRate = totalRequests ? totalErrors / totalRequests : 0;
  lines.push('# HELP aspb_queue_depth Current background queue depth.');
  lines.push('# TYPE aspb_queue_depth gauge');
  lines.push(metricLine('aspb_queue_depth', { queue: 'email_outbox' }, emailPending));
  lines.push(metricLine('aspb_queue_depth', { queue: 'email_outbox_failed' }, emailFailed));
  lines.push(metricLine('aspb_queue_depth', { queue: 'user_auth_email_outbox' }, userAuthEmailPending));
  lines.push(metricLine('aspb_queue_depth', { queue: 'user_auth_email_outbox_failed' }, userAuthEmailFailed));
  lines.push(metricLine('aspb_queue_depth', { queue: 'user_auth_email_outbox_dead_letter' }, userAuthEmailDeadLetters));
  lines.push(metricLine('aspb_queue_depth', { queue: 'invitation_email_outbox' }, invitationEmailPending));
  lines.push(metricLine('aspb_queue_depth', { queue: 'invitation_email_outbox_failed' }, invitationEmailFailed));
  lines.push(
    metricLine('aspb_queue_depth', { queue: 'invitation_email_outbox_dead_letter' }, invitationEmailDeadLetters),
  );
  lines.push(metricLine('aspb_queue_depth', { queue: 'telegram_broadcast' }, broadcastPending));
  lines.push(metricLine('aspb_queue_depth', { queue: 'telegram_broadcast_dead_letter' }, broadcastDeadLetters));
  lines.push('# HELP aspb_alert_state Boolean alert states.');
  lines.push('# TYPE aspb_alert_state gauge');
  lines.push(metricLine('aspb_alert_state', { alert: 'http_5xx_rate_gt_1pct' }, errorRate > 0.01 ? 1 : 0));
  lines.push(metricLine('aspb_alert_state', { alert: 'email_failed_jobs' }, emailFailed > 0 ? 1 : 0));
  lines.push(
    metricLine(
      'aspb_alert_state',
      { alert: 'user_auth_email_failed_or_dead_letter_jobs' },
      userAuthEmailFailed > 0 || userAuthEmailDeadLetters > 0 ? 1 : 0,
    ),
  );
  lines.push(
    metricLine(
      'aspb_alert_state',
      { alert: 'invitation_email_failed_or_dead_letter_jobs' },
      invitationEmailFailed > 0 || invitationEmailDeadLetters > 0 ? 1 : 0,
    ),
  );
  lines.push(
    metricLine('aspb_alert_state', { alert: 'telegram_broadcast_dead_letters' }, broadcastDeadLetters > 0 ? 1 : 0),
  );
  lines.push(
    metricLine('aspb_alert_state', { alert: 'telegram_broadcast_queue_gt_100' }, broadcastPending > 100 ? 1 : 0),
  );

  return `${lines.join('\n')}\n`;
}
