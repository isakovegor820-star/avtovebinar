import {
  argValue,
  baseReport,
  fetchWithTimeout,
  hasArg,
  maskedTarget,
  requireNetworkGuard,
  writeReport,
} from './lib.mjs';

const execute = hasArg('--execute');
const plannedChecks = [
  'health_readiness_and_protected_details',
  'synthetic_onboarding_author_wizard',
  'cross_tenant_negative_matrix',
  'media_upload_resume_finalize_hls_range',
  'fake_provider_transcript_submit_poll_result_delete',
  'notification_no_send_default',
];

try {
  if (!execute) {
    writeReport('smoke', {
      ...baseReport('smoke', 'dry-run'),
      status: 'planned_offline',
      plannedChecks,
      externalSections: 'blocked_external',
    });
  } else {
    const target = requireNetworkGuard(argValue('--url'));
    const checks = [];
    for (const pathname of ['/health', '/ready']) {
      const response = await fetchWithTimeout(new URL(pathname, target), { headers: { accept: 'application/json' } });
      checks.push({ name: pathname.slice(1), status: response.ok ? 'passed' : 'failed', httpStatus: response.status });
    }
    const failed = checks.some(check => check.status === 'failed');
    writeReport('smoke', {
      ...baseReport('smoke', 'guarded-staging'),
      status: failed ? 'failed' : 'partial_passed',
      target: maskedTarget(target),
      checks,
      remainingChecks: plannedChecks.slice(1).map(name => ({ name, status: 'blocked_external' })),
      note: 'No notification send or provider job was attempted.',
    });
    if (failed) process.exitCode = 2;
  }
} catch (error) {
  writeReport('smoke', {
    ...baseReport('smoke', execute ? 'guarded-staging' : 'dry-run'),
    status: 'failed',
    errorCode: error instanceof Error ? error.message : 'unknown_error',
  });
  process.exitCode = 2;
}
