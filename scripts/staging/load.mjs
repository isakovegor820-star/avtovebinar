import {
  SYNTHETIC_MARKER,
  argValue,
  baseReport,
  fetchWithTimeout,
  hasArg,
  maskedTarget,
  requireNetworkGuard,
  writeReport,
} from './lib.mjs';

const profiles = {
  low: { concurrentViewers: 3, platformViewers: 10, authorCrmUsers: 2, requestsPerActor: 2 },
  target: { concurrentViewers: 300, platformViewers: 1000, authorCrmUsers: 100, requestsPerActor: 10 },
};
const profileName = argValue('--profile') ?? 'low';
const profile = profiles[profileName];
const execute = hasArg('--execute');

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function privateCookie(name) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (value.length > 8_192 || /[\r\n]/.test(value) || !value.includes('=')) {
    throw new Error('invalid_synthetic_session_cookie');
  }
  return value;
}

function hlsPath() {
  const value = argValue('--hls-path');
  if (!value) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('..') || /[?#]/.test(value)) {
    throw new Error('unsafe_hls_path_rejected');
  }
  return value;
}

async function runActor(target, workload) {
  const results = [];
  for (let request = 0; request < workload.requestsPerActor; request += 1) {
    const requestStarted = performance.now();
    try {
      const response = await fetchWithTimeout(
        new URL(workload.pathname, target),
        {
          headers: {
            accept: workload.accept,
            'cache-control': 'no-cache',
            'x-aspb-synthetic-fixture': SYNTHETIC_MARKER,
            ...(workload.cookie ? { cookie: workload.cookie } : {}),
          },
        },
        8_000,
      );
      results.push({ durationMs: performance.now() - requestStarted, ok: response.ok });
    } catch {
      results.push({ durationMs: performance.now() - requestStarted, ok: false });
    }
  }
  return results;
}

async function runGroup(target, workload) {
  const started = Date.now();
  const actorResults = await Promise.all(Array.from({ length: workload.actors }, () => runActor(target, workload)));
  const results = actorResults.flat();
  const durations = results.map(result => result.durationMs);
  const errors = results.filter(result => !result.ok).length;
  return {
    name: workload.name,
    trafficClass: workload.trafficClass,
    status: errors === 0 ? 'passed' : 'failed',
    actors: workload.actors,
    requestsPerActor: workload.requestsPerActor,
    requestCount: results.length,
    elapsedMs: Date.now() - started,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    errorRate: errors / Math.max(1, results.length),
  };
}

try {
  if (!profile) throw new Error('unknown_load_profile');
  if (profileName === 'target' && process.env.ASPB_ALLOW_STAGING_LOAD !== 'on') {
    throw new Error('target_load_guard_required');
  }
  const mediaPath = hlsPath();
  if (!execute) {
    writeReport('load', {
      ...baseReport('load', 'dry-run'),
      status: 'planned_offline',
      profile: profileName,
      workload: profile,
      groups: [
        { name: 'session_viewers_json', actors: profile.concurrentViewers, trafficClass: 'json_api' },
        { name: 'platform_catalog_json', actors: profile.platformViewers, trafficClass: 'json_api' },
        { name: 'author_crm_json', actors: profile.authorCrmUsers, trafficClass: 'json_api' },
        { name: 'session_viewers_hls', actors: profile.concurrentViewers, trafficClass: 'hls_media' },
      ],
      separatedTraffic: ['json_api', 'hls_media'],
      metrics: ['p50', 'p95', 'p99', 'errorRate', 'queueLag', 'eventLoop', 'dbSaturation', 'providerSaturation'],
      requiredForTargetExecution: [
        'ASPB_STAGING_AUTHOR_CRM_COOKIE',
        '--hls-path',
        'external low-cardinality saturation metrics capture',
      ],
    });
  } else {
    const target = requireNetworkGuard(argValue('--url'));
    const authorCrmCookie = privateCookie('ASPB_STAGING_AUTHOR_CRM_COOKIE');
    const viewerCookie = privateCookie('ASPB_STAGING_VIEWER_COOKIE');
    if (profileName === 'target' && (!authorCrmCookie || !mediaPath)) {
      throw new Error('target_synthetic_sessions_and_hls_path_required');
    }

    const workloads = [
      {
        name: 'session_viewers_json',
        trafficClass: 'json_api',
        actors: profile.concurrentViewers,
        requestsPerActor: profile.requestsPerActor,
        pathname: '/api/webinar/current',
        accept: 'application/json',
        cookie: viewerCookie,
      },
      {
        name: 'platform_catalog_json',
        trafficClass: 'json_api',
        actors: profile.platformViewers,
        requestsPerActor: profile.requestsPerActor,
        pathname: '/api/v1/catalog/search?pageSize=1',
        accept: 'application/json',
        cookie: null,
      },
      ...(authorCrmCookie
        ? [
            {
              name: 'author_crm_json',
              trafficClass: 'json_api',
              actors: profile.authorCrmUsers,
              requestsPerActor: profile.requestsPerActor,
              pathname: '/api/v1/crm/queues',
              accept: 'application/json',
              cookie: authorCrmCookie,
            },
          ]
        : []),
      ...(mediaPath
        ? [
            {
              name: 'session_viewers_hls',
              trafficClass: 'hls_media',
              actors: profile.concurrentViewers,
              requestsPerActor: profile.requestsPerActor,
              pathname: mediaPath,
              accept: 'application/vnd.apple.mpegurl',
              cookie: viewerCookie,
            },
          ]
        : []),
    ];
    const started = Date.now();
    const groups = [];
    for (const workload of workloads) groups.push(await runGroup(target, workload));
    if (!authorCrmCookie)
      groups.push({ name: 'author_crm_json', trafficClass: 'json_api', status: 'blocked_external' });
    if (!mediaPath) groups.push({ name: 'session_viewers_hls', trafficClass: 'hls_media', status: 'blocked_external' });
    const failed = groups.some(group => group.status === 'failed');
    const incomplete = groups.some(group => group.status === 'blocked_external');
    writeReport('load', {
      ...baseReport('load', 'guarded-staging'),
      status: failed ? 'failed' : incomplete ? 'partial_passed' : 'partial_passed_metrics_blocked',
      target: maskedTarget(target),
      profile: profileName,
      elapsedMs: Date.now() - started,
      groups,
      saturationMetrics: 'blocked_external_metrics_connector_required',
      secretsIncludedInReport: false,
    });
    if (failed) process.exitCode = 2;
  }
} catch (error) {
  writeReport('load', {
    ...baseReport('load', execute ? 'guarded-staging' : 'dry-run'),
    status: 'failed',
    errorCode: error instanceof Error ? error.message : 'unknown_error',
  });
  process.exitCode = 2;
}
