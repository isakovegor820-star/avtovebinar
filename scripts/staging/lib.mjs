import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SYNTHETIC_MARKER = 'ASPB_SYNTHETIC_ONLY_v1';

export function hasArg(name) {
  return process.argv.includes(name);
}

export function argValue(name) {
  const prefix = `${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

export function safeStagingTarget(raw) {
  if (!raw) throw new Error('staging_url_required');
  const url = new URL(raw);
  const allowedHost = process.env.ASPB_STAGING_ALLOWED_HOST?.trim().toLowerCase();
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') throw new Error('staging_https_required');
  if (!allowedHost || host !== allowedHost) throw new Error('staging_host_not_allowlisted');
  if (!host.includes('staging') || /(^|[.-])(prod|production)([.-]|$)/i.test(host)) {
    throw new Error('production_or_unknown_host_rejected');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('staging_url_must_not_contain_credentials');
  return url;
}

export function requireNetworkGuard(target) {
  if (process.env.ASPB_ALLOW_STAGING_ACCEPTANCE !== 'on') throw new Error('staging_acceptance_guard_required');
  return safeStagingTarget(target);
}

export function maskedTarget(url) {
  return `${url.protocol}//<staging-host>`;
}

export function reportPath(tool) {
  const requested = argValue('--report');
  if (requested) {
    const resolved = path.resolve(requested);
    const allowedRoot = path.resolve(process.cwd(), 'artifacts', 'staging-acceptance');
    if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) {
      throw new Error('report_path_outside_safe_artifact_directory');
    }
    return resolved;
  }
  return path.join(os.tmpdir(), 'aspb-staging-acceptance', `${tool}-${Date.now()}.json`);
}

export function writeReport(tool, report) {
  const output = reportPath(tool);
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...report, reportFile: output }, null, 2)}\n`);
  return output;
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
  } finally {
    clearTimeout(timeout);
  }
}

export function baseReport(tool, mode) {
  return {
    schemaVersion: 1,
    tool,
    mode,
    fixtureClassification: SYNTHETIC_MARKER,
    generatedAt: new Date().toISOString(),
    containsSensitiveData: false,
  };
}
