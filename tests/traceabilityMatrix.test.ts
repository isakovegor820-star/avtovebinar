import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const requirements = readFileSync(new URL('../docs/ASPB-LEGAL-PLATFORM-TZ.md', import.meta.url), 'utf8');
const matrix = readFileSync(new URL('../docs/ASPB-TZ-TRACEABILITY-MATRIX.md', import.meta.url), 'utf8');

function uniqueMatches(source: string, pattern: RegExp) {
  return [...new Set(source.match(pattern) ?? [])].sort();
}

describe('ТЗ traceability matrix', () => {
  it('contains every functional, NFR, and acceptance requirement ID from the ТЗ', () => {
    const requirementIds = uniqueMatches(requirements, /\b(?:[A-Z]{2,}-\d{3}|NFR-\d{2}|AC-\d{2})\b/g);
    const matrixIds = new Set(uniqueMatches(matrix, /\b(?:[A-Z]{2,}-\d{3}|NFR-\d{2}|AC-\d{2})\b/g));

    expect(requirementIds.filter(id => !matrixIds.has(id))).toEqual([]);
  });

  it('covers every interface section and Definition of Done row', () => {
    for (let section = 1; section <= 8; section += 1) {
      expect(matrix, `missing interface section 12.${section}`).toContain(`| 12.${section} `);
    }
    for (let row = 1; row <= 13; row += 1) {
      const id = `DOD-${String(row).padStart(2, '0')}`;
      expect(matrix, `missing ${id}`).toContain(`| ${id} `);
    }
  });
});
