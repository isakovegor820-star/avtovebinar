import { readFileSync } from 'node:fs';
import { baseReport, hasArg, writeReport } from './lib.mjs';

const execute = hasArg('--execute');
try {
  if (execute) {
    if (process.env.ASPB_ALLOW_STAGING_ACCEPTANCE !== 'on' || process.env.ASPB_ALLOW_PROVIDER_ACCEPTANCE !== 'on') {
      throw new Error('provider_acceptance_guards_required');
    }
    throw new Error('blocked_external_credentials_and_budget_approval_required');
  }
  const storage = readFileSync(new URL('../../src/lib/mediaStorageS3.ts', import.meta.url), 'utf8');
  const speech = readFileSync(new URL('../../src/lib/speechToTextYandex.ts', import.meta.url), 'utf8');
  const checks = [
    ['object_storage_multipart', /createMultipartUpload|CreateMultipartUploadCommand/.test(storage)],
    ['object_storage_resume_list_parts', /ListPartsCommand/.test(storage)],
    ['object_storage_head_private_range', /HeadObjectCommand/.test(storage) && /Range/.test(storage)],
    ['object_storage_abort_delete', /AbortMultipartUploadCommand/.test(storage) && /DeleteObjectCommand/.test(storage)],
    ['speech_submit_poll_result_delete', /submit\(|poll\(|getResult\(|delete\(/.test(speech)],
    ['speech_no_data_logging_header', !/x-data-logging-enabled/i.test(speech)],
    ['speech_no_autotuning_or_corpus', !/autotun|corpus|support upload/i.test(speech)],
  ].map(([name, passed]) => ({ name, status: passed ? 'passed_offline' : 'failed' }));
  const failed = checks.some(check => check.status === 'failed');
  writeReport('provider-acceptance', {
    ...baseReport('provider-acceptance', 'offline-contract'),
    status: failed ? 'failed' : 'passed_offline',
    checks,
    externalSections: 'blocked_external',
    externalReason: 'credentials_dpa_budget_and_staging_approval_required',
  });
  if (failed) process.exitCode = 2;
} catch (error) {
  writeReport('provider-acceptance', {
    ...baseReport('provider-acceptance', execute ? 'guarded-staging' : 'offline-contract'),
    status: 'failed',
    errorCode: error instanceof Error ? error.message : 'unknown_error',
  });
  process.exitCode = 2;
}
