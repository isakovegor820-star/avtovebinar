import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectCreatorWizardSteps } from '../src/lib/tenancy/webinarContent.js';

const exactLabels = [
  'Основная информация',
  'Юридическая классификация и актуальность',
  'Видео',
  'Транскрипт и главы',
  'Источники и материалы',
  'Подготовленный чат',
  'Расписание и доступ',
  'Проверка и публикация',
];

describe('creator eight-step wizard', () => {
  it('returns the exact ordered steps and only the four public statuses', () => {
    const steps = projectCreatorWizardSteps({
      authorEligible: true,
      basicMissingCount: 6,
      legalMissingCount: 7,
      mediaStatus: 'NOT_UPLOADED',
      transcriptStatus: 'NOT_AVAILABLE',
      scenarioStatus: 'NOT_AVAILABLE',
      syntheticDisclosureMissing: false,
      sourceAndMaterialCount: 0,
      sessionCount: 0,
      contentStatus: 'DRAFT',
      blockerCount: 4,
    });

    expect(steps.map(step => step.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(steps.map(step => step.label)).toEqual(exactLabels);
    expect(steps.map(step => step.status)).toEqual([
      'not_started',
      'not_started',
      'not_started',
      'blocked',
      'not_started',
      'not_started',
      'not_started',
      'blocked',
    ]);
    expect(new Set(steps.map(step => step.status))).toEqual(new Set(['not_started', 'blocked']));
  });

  it('does not report unfinished provider work as complete', () => {
    const steps = projectCreatorWizardSteps({
      authorEligible: true,
      basicMissingCount: 2,
      legalMissingCount: 3,
      mediaStatus: 'PROCESSING',
      transcriptStatus: 'DRAFT',
      scenarioStatus: 'DRAFT',
      syntheticDisclosureMissing: true,
      sourceAndMaterialCount: 1,
      sessionCount: 1,
      contentStatus: 'IN_MODERATION',
      blockerCount: 5,
    });

    expect(steps.map(step => step.status)).toEqual([
      'in_progress',
      'in_progress',
      'in_progress',
      'blocked',
      'complete',
      'in_progress',
      'complete',
      'in_progress',
    ]);
  });

  it('marks all steps complete only from a fully ready persisted snapshot', () => {
    const steps = projectCreatorWizardSteps({
      authorEligible: true,
      basicMissingCount: 0,
      legalMissingCount: 0,
      mediaStatus: 'READY',
      transcriptStatus: 'PUBLISHED',
      scenarioStatus: 'PUBLISHED',
      syntheticDisclosureMissing: false,
      sourceAndMaterialCount: 2,
      sessionCount: 1,
      contentStatus: 'READY',
      blockerCount: 0,
    });

    expect(steps.every(step => step.status === 'complete')).toBe(true);
  });

  it('keeps step groups, URL history and idempotent autosave in the browser contract', () => {
    const html = readFileSync(new URL('../crisis_premium/creator-webinars.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('../crisis_premium/js/creator-webinars.js', import.meta.url), 'utf8');

    expect(html).toContain('id="creatorWizardStep1Fields"');
    expect(html).toContain('id="creatorWizardStep2Fields"');
    expect(html).toContain('id="creatorSyntheticDisclosure"');
    expect(script).toContain('window.history.pushState({ creatorWizard: true }');
    expect(script).toContain("window.addEventListener('popstate'");
    expect(script).toContain("{ 'Idempotency-Key': key }");
    expect(script).toContain('scheduleMetadataAutosave(900)');
    expect(script).toContain('scheduleMetadataAutosave(0)');
  });
});
