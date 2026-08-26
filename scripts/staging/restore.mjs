import { argValue, baseReport, hasArg, writeReport } from './lib.mjs';

const execute = hasArg('--execute');
const source = argValue('--source');
const target = argValue('--target');
const targetSchema = argValue('--target-schema');
const sourcePrefix = argValue('--source-media-prefix');
const targetPrefix = argValue('--target-media-prefix');

try {
  const supplied = [source, target, targetSchema, sourcePrefix, targetPrefix].every(Boolean);
  if (!supplied && execute) throw new Error('restore_arguments_required');
  if (supplied) {
    if (source === target || sourcePrefix === targetPrefix) throw new Error('restore_source_target_must_differ');
    if (!targetSchema.includes('restore_drill') || /prod|production/i.test(`${target} ${targetSchema} ${targetPrefix}`)) {
      throw new Error('unsafe_restore_target_rejected');
    }
    if (targetPrefix === '/' || targetPrefix === '.' || targetPrefix.includes('..')) {
      throw new Error('unsafe_restore_prefix_rejected');
    }
  }
  if (execute) {
    if (
      process.env.ASPB_ALLOW_STAGING_ACCEPTANCE !== 'on' ||
      process.env.ASPB_ALLOW_STAGING_RESTORE !== 'on' ||
      process.env.ASPB_CONFIRM_EMPTY_RESTORE_TARGET !== 'on'
    ) {
      throw new Error('restore_guards_required');
    }
    throw new Error('blocked_external_restore_connector_not_configured');
  }
  writeReport('restore', {
    ...baseReport('restore', 'dry-run'),
    status: supplied ? 'planned_offline' : 'arguments_required_for_target_validation',
    invariants: [
      'new_isolated_postgresql_target',
      'distinct_private_media_prefix',
      'empty_target_confirmation',
      'migration_status',
      'row_invariants',
      'object_count_and_checksum',
      'legacy_replay',
      'rollback_image_compatibility',
      'source_backup_preserved',
      'no_down_migration',
    ],
  });
} catch (error) {
  writeReport('restore', {
    ...baseReport('restore', execute ? 'guarded-staging' : 'dry-run'),
    status: 'failed',
    errorCode: error instanceof Error ? error.message : 'unknown_error',
  });
  process.exitCode = 2;
}
