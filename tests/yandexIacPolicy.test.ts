import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../infra/yandex/staging/', import.meta.url);
const sources = readdirSync(root)
  .filter(name => name.endsWith('.tf'))
  .map(name => readFileSync(new URL(name, root), 'utf8'))
  .join('\n');

describe('Yandex staging IaC policy', () => {
  it('pins the provider and enforces a staging-only environment', () => {
    expect(sources).toContain('version = "~> 0.220.0"');
    expect(sources).toContain('var.environment == "staging"');
    expect(sources).toContain('name_prefix = "${var.project_name}-staging"');
  });

  it('keeps the bucket private, encrypted, versioned and lifecycle guarded', () => {
    expect(sources).toContain('defaults the bucket ACL to private');
    expect(sources).not.toMatch(/^\s*acl\s*=/m);
    expect(sources).toContain('read        = false');
    expect(sources).toContain('list        = false');
    expect(sources).toContain('config_read = false');
    expect(sources).toContain('versioning { enabled = true }');
    expect(sources).toContain('server_side_encryption_configuration');
    expect(sources).toContain('abort_incomplete_multipart_upload_days');
    expect(sources).toContain('expose_headers  = ["ETag"]');
    expect(sources).toContain('prevent_destroy = true');
    expect(sources).not.toMatch(/acl\s*=\s*"public|system:allUsers|allowed_origins\s*=\s*\["\*"\]/);
  });

  it('contains no inline credentials, secret versions or broad primitive roles', () => {
    expect(sources).not.toMatch(/access_key\s*=|secret_key\s*=|token\s*=|password\s*=/i);
    expect(sources).not.toContain('yandex_lockbox_secret_version');
    expect(sources).not.toMatch(/role\s*=\s*"(?:admin|editor|owner)"/);
    expect(sources).not.toMatch(/terraform\s*\{[\s\S]*backend\s+"/);
  });
});
