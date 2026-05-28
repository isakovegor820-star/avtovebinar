import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../lib/env.js';
import { CRM_STATUS_LABELS, CRM_STATUSES } from '../lib/crm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');
const adminHtmlPath = path.join(rootDir, 'crisis_premium', 'admin.html');

let adminHtmlCache: string | null = null;

export function getAdminHtml(): string {
  if (adminHtmlCache && env.NODE_ENV === 'production') {
    return adminHtmlCache;
  }
  let html = readFileSync(adminHtmlPath, 'utf8');
  const crmJson = JSON.stringify(CRM_STATUSES.map(status => ({ value: status, label: CRM_STATUS_LABELS[status] })));
  html = html.replace('/*__CRM_STATUSES_JSON__*/[]', crmJson);
  adminHtmlCache = html;
  return html;
}
