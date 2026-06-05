import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { env } from './lib/env.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { errorMiddleware } from './lib/http.js';
import { getReadiness } from './lib/health.js';
import { csrfProtection, ensureCsrfToken } from './lib/csrf.js';
import { cspStyleAttributeHashes, cspStyleElementHashes } from './lib/cspInlineHashes.js';
import { requestContextMiddleware } from './lib/requestContext.js';
import { metricsMiddleware, renderPrometheusMetrics } from './lib/metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const frontendDir = path.join(rootDir, 'crisis_premium');

export const app = express();

app.set('trust proxy', 1);
app.use(requestContextMiddleware);
app.use(metricsMiddleware);
app.use((_req, res, next) => {
  res.locals.nonce = crypto.randomUUID();
  next();
});
app.use(
  helmet({
    crossOriginEmbedderPolicy: true,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: [
          "'self'",
          "'unsafe-hashes'",
          ...cspStyleElementHashes,
          ...cspStyleAttributeHashes,
          'https://fonts.googleapis.com',
        ],
        styleSrcElem: ["'self'", ...cspStyleElementHashes, 'https://fonts.googleapis.com'],
        styleSrcAttr: ["'unsafe-hashes'", ...cspStyleAttributeHashes],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        formAction: ["'self'"],
      },
    },
  }),
);
app.use(
  cors({
    origin: env.NODE_ENV === 'production' ? env.CORS_ORIGIN.split(',').map(origin => origin.trim()) : true,
    credentials: true,
  }),
);
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(ensureCsrfToken);
app.use(csrfProtection);

const formLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const tokenReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 90,
  standardHeaders: true,
  legacyHeaders: false,
});

const eventLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Слишком много попыток входа. Попробуйте позже.' },
});

const adminBroadcastLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Слишком много запусков рассылки. Попробуйте позже.' },
});

app.use('/api/register', formLimiter);
app.use('/api/questions', formLimiter);
app.use('/api/partner-application', formLimiter);
app.use('/api/events', eventLimiter);
app.use('/api/telegram-click', eventLimiter);
app.use('/api/registration', tokenReadLimiter);
app.use('/api/webinar/current', tokenReadLimiter);
app.use('/api/webinar/timeline', tokenReadLimiter);
app.use('/api/webinar/chat', tokenReadLimiter);
app.use('/api/admin/login', adminLoginLimiter);
app.use('/api/admin/telegram/broadcast', adminBroadcastLimiter);

app.use('/api', publicRouter);
app.use(adminRouter);

app.get('/metrics', async (_req, res, next) => {
  try {
    res.type('text/plain; version=0.0.4; charset=utf-8').send(await renderPrometheusMetrics());
  } catch (error) {
    next(error);
  }
});
app.get('/health/live', (_req, res) => {
  res.json({ ok: true, service: 'aspb-autowebinar' });
});
app.get('/health/ready', async (_req, res, next) => {
  try {
    const readiness = await getReadiness();
    res.status(readiness.ok ? 200 : 503).json({ service: 'aspb-autowebinar', ...readiness });
  } catch (error) {
    next(error);
  }
});
app.get('/.well-known/security.txt', (_req, res) => {
  res.type('text/plain').sendFile(path.join(frontendDir, '.well-known', 'security.txt'), { dotfiles: 'allow' });
});
app.get('/openapi.yml', (_req, res) => {
  res.type('application/yaml').sendFile(path.join(rootDir, 'openapi.yml'));
});
app.get('/docs', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ASPB API Docs</title></head>
<body>
<h1>ASPB Autowebinar API</h1>
<p>Минимальная документация API. OpenAPI YAML доступен по <a href="/openapi.yml">/openapi.yml</a>.</p>
<ul>
<li>Room access: one-time exchange-token -> HttpOnly cookie <code>aspb_room_token</code>.</li>
<li>Mutation endpoints with cookies require <code>x-csrf-token</code>.</li>
<li>Ops endpoints: <code>/health/live</code>, <code>/health/ready</code>, <code>/metrics</code>.</li>
</ul>
</body></html>`);
});
const staticOptions = {
  setHeaders(res: { setHeader: (name: string, value: string) => void }, filePath: string) {
    if (/\.[a-f0-9]{8,}\.(?:css|js|png|jpg|jpeg|webp|svg|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return;
    }

    if (/\.(?:css|js|png|jpg|jpeg|webp|svg|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
};
app.use('/crisis_premium', express.static(frontendDir, staticOptions));
app.use(express.static(frontendDir, staticOptions));

app.get('/', (_req, res) => {
  res.redirect('/crisis_premium/index.html');
});

app.use(errorMiddleware);
