import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tools = ['smoke.mjs', 'load.mjs', 'media-4gib.mjs', 'restore.mjs', 'provider-acceptance.mjs'];
const root = new URL('../scripts/staging/', import.meta.url);

describe('staging acceptance tool safety', () => {
  it('keeps network tools behind explicit staging guards and dry-run defaults', () => {
    const library = readFileSync(new URL('lib.mjs', root), 'utf8');
    expect(library).toContain("ASPB_ALLOW_STAGING_ACCEPTANCE !== 'on'");
    expect(library).toContain("url.protocol !== 'https:'");
    expect(library).toContain('staging_host_not_allowlisted');
    expect(library).toContain('SYNTHETIC_MARKER');
    for (const tool of tools) expect(readFileSync(new URL(tool, root), 'utf8')).toContain('baseReport');
  });

  it('defines exact target load and four GiB contracts without allocating a full file', () => {
    const load = readFileSync(new URL('load.mjs', root), 'utf8');
    const media = readFileSync(new URL('media-4gib.mjs', root), 'utf8');
    expect(load).toContain('concurrentViewers: 300');
    expect(load).toContain('platformViewers: 1000');
    expect(load).toContain('authorCrmUsers: 100');
    expect(load).toContain('ASPB_ALLOW_STAGING_LOAD');
    expect(load).toContain("name: 'session_viewers_json'");
    expect(load).toContain("name: 'platform_catalog_json'");
    expect(load).toContain("name: 'author_crm_json'");
    expect(load).toContain("name: 'session_viewers_hls'");
    expect(load).toContain("trafficClass: 'hls_media'");
    expect(load).toContain('ASPB_STAGING_AUTHOR_CRM_COOKIE');
    expect(load).toContain('unsafe_hls_path_rejected');
    expect(load).not.toMatch(/console\.log|response\.text|response\.json/);
    expect(media).toContain('4n * 1024n * 1024n * 1024n');
    expect(media).toContain('Buffer.alloc(PART_BYTES');
    expect(media).not.toMatch(/writeFile|createWriteStream/);
  });

  it('smokes the real dependency-aware readiness endpoint', () => {
    const smoke = readFileSync(new URL('smoke.mjs', root), 'utf8');
    expect(smoke).toContain("['/health', '/health/ready']");
    expect(smoke).not.toContain("['/health', '/ready']");
  });
});
