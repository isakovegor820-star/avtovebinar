import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const rulesPath = new URL('../infra/monitoring/prometheus/aspb.rules.yml', import.meta.url);
const alertmanagerPath = new URL('../infra/monitoring/alertmanager/alertmanager.example.yml', import.meta.url);
const dashboardPath = new URL('../infra/monitoring/grafana/dashboards/aspb-overview.json', import.meta.url);

describe('monitoring templates', () => {
  it('parses rules and requires safe critical alert annotations', () => {
    const source = readFileSync(rulesPath, 'utf8');
    const document = parse(source) as { groups: Array<{ rules: Array<Record<string, unknown>> }> };
    const alerts = document.groups.flatMap(group => group.rules).filter(rule => rule.alert) as Array<{
      alert: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    }>;
    expect(alerts.length).toBeGreaterThanOrEqual(15);
    for (const alert of alerts.filter(item => item.labels?.severity === 'critical')) {
      expect(alert.labels).toMatchObject({ service: expect.any(String), team: expect.any(String) });
      expect(alert.annotations?.runbook).toMatch(/^docs\/production-runbook\.md#[a-z0-9-]+$/);
      expect(alert.annotations?.recovery).toEqual(expect.any(String));
    }
    expect(source).not.toMatch(/\$labels\.(?:email|phone|chat_?id|token|secret|storage_key)\b/i);
    expect(source).not.toMatch(/(?:email|phone|chat_?id|token|secret|storage_key)\s*:\s*['"]?\{\{/i);
  });

  it('parses placeholder-only Alertmanager and dashboard templates', () => {
    const alertmanager = readFileSync(alertmanagerPath, 'utf8');
    expect(() => parse(alertmanager)).not.toThrow();
    expect(alertmanager).toContain('placeholder.invalid');
    expect(alertmanager).not.toMatch(/t\.me|hooks\.slack|api\.telegram/i);
    expect(() => JSON.parse(readFileSync(dashboardPath, 'utf8'))).not.toThrow();
  });
});
