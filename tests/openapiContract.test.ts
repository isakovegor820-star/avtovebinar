import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

function resolveLocalRef(document: unknown, ref: string) {
  if (!ref.startsWith('#/')) return true;
  return ref
    .slice(2)
    .split('/')
    .map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((value, token) => {
      if (!value || typeof value !== 'object') return undefined;
      return (value as Record<string, unknown>)[token];
    }, document);
}

describe('OpenAPI contract', () => {
  it('parses and has no missing local references', () => {
    const source = readFileSync(new URL('../openapi.yml', import.meta.url), 'utf8');
    const document = parse(source) as Record<string, unknown>;
    expect(document.openapi).toBe('3.0.3');
    const refs = [...source.matchAll(/\$ref:\s*['"]?(#[^'"\s}]+)/g)].map(match => match[1]);
    expect(refs.filter(ref => resolveLocalRef(document, ref) === undefined)).toEqual([]);
  });

  it('documents every gap-closing endpoint family', () => {
    const document = parse(readFileSync(new URL('../openapi.yml', import.meta.url), 'utf8')) as {
      paths: Record<string, unknown>;
    };
    for (const path of [
      '/api/v1/catalog/authors/{authorSlug}',
      '/api/v1/creator/webinars/{webinarId}/readiness',
      '/api/v1/creator/webinars/{webinarId}/chapters',
      '/api/v1/creator/webinars/{webinarId}/materials/uploads',
      '/api/v1/creator/review-tasks',
      '/api/v1/organizations/{organizationId}/retention/plan',
      '/api/admin/platform/tenant-rollouts',
      '/api/admin/platform/legal-holds',
    ]) {
      expect(document.paths[path], path).toBeDefined();
    }
  });

  it('publishes the exact creator wizard readiness status vocabulary', () => {
    const document = parse(readFileSync(new URL('../openapi.yml', import.meta.url), 'utf8')) as {
      components: { schemas: Record<string, any> };
    };
    const readiness = document.components.schemas.CreatorWizardReadinessResponse.properties.readiness;
    const status = readiness.properties.steps.items.properties.status;
    expect(status.enum).toEqual(['not_started', 'in_progress', 'complete', 'blocked']);
    expect(readiness.properties.steps.minItems).toBe(8);
    expect(readiness.properties.steps.maxItems).toBe(8);
  });
});
