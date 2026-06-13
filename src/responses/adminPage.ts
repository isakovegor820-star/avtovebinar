import { readFileSync } from 'node:fs';
import path from 'node:path';
import { env } from '../lib/env.js';

// Берём crisis_premium из process.cwd() — так же, как app.ts резолвит frontendDir.
// Прежний path.resolve(__dirname, '..', '..') ломался в проде: compiled-файл лежит в
// dist/src/responses/, поэтому путь указывал на /app/dist/crisis_premium (нет файла) → 500.
const rootDir = process.cwd();
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
