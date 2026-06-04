import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../lib/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');
const adminHtmlPath = path.join(rootDir, 'crisis_premium', 'admin.html');

let adminHtmlCache: string | null = null;

export function getAdminHtml(): string {
  if (adminHtmlCache && env.NODE_ENV === 'production') {
    return adminHtmlCache;
  }
  const html = readFileSync(adminHtmlPath, 'utf8');
  adminHtmlCache = html;
  return html;
}
