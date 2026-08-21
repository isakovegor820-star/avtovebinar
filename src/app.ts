import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from './lib/env.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { errorMiddleware } from './lib/http.js';
import { getCachedDependencyStatus, getDependencySummary, getReadiness } from './lib/health.js';
import { csrfProtection, ensureCsrfToken } from './lib/csrf.js';
import { cspStyleAttributeHashes, cspStyleElementHashes } from './lib/cspInlineHashes.js';
import { requestContextMiddleware } from './lib/requestContext.js';
import { metricsMiddleware, renderPrometheusMetrics } from './lib/metrics.js';
import { getVideoCspOrigins } from './lib/webinarVideo.js';
import { visitorIdentityMiddleware } from './lib/visitor.js';
import { getPlatformFeatureFlags } from './lib/featureFlags.js';
import { listCatalogSitemapEntries } from './lib/catalog.js';
import { prisma } from './lib/prisma.js';
import { getMediaUploadCspOrigins } from './lib/mediaStorage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = process.cwd();
const frontendDir = path.join(rootDir, 'crisis_premium');
const videoCspOrigins = getVideoCspOrigins();
const mediaUploadCspOrigins = getMediaUploadCspOrigins();

export const app = express();

function parseTrustProxy(value: typeof env.TRUST_PROXY) {
  if (value === '1' || value === 'true') {
    return 1;
  }
  if (value === 'loopback') {
    return 'loopback';
  }
  return false;
}

function metricsBearerToken(req: Request) {
  const authorization = req.get('authorization');
  const prefix = 'Bearer ';
  if (!authorization?.startsWith(prefix)) return '';
  return authorization.slice(prefix.length).trim();
}

function metricsTokenMatches(submittedToken: string, expectedToken: string) {
  const submitted = Buffer.from(submittedToken);
  const expected = Buffer.from(expectedToken);
  return submitted.length === expected.length && crypto.timingSafeEqual(submitted, expected);
}

function requireProductionMetricsToken(req: Request, res: Response) {
  if (env.NODE_ENV !== 'production') {
    return true;
  }

  const expectedToken = env.METRICS_TOKEN;
  const submittedToken = metricsBearerToken(req);
  if (!expectedToken || !submittedToken) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
    res.status(401).json({ ok: false, error: 'Metrics token is required' });
    return false;
  }

  if (!metricsTokenMatches(submittedToken, expectedToken)) {
    res.status(403).json({ ok: false, error: 'Metrics token is invalid' });
    return false;
  }

  return true;
}

app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));
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
        // Шрифты self-hosted (crisis_premium/fonts.css + assets/fonts) — обращений к Google Fonts нет (152-ФЗ: IP посетителя за рубеж не уходит)
        styleSrc: ["'self'", "'unsafe-hashes'", ...cspStyleElementHashes, ...cspStyleAttributeHashes],
        styleSrcElem: ["'self'", ...cspStyleElementHashes],
        styleSrcAttr: ["'unsafe-hashes'", ...cspStyleAttributeHashes],
        fontSrc: ["'self'", 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        mediaSrc: ["'self'", 'blob:', 'data:', ...videoCspOrigins],
        connectSrc: ["'self'", ...videoCspOrigins, ...mediaUploadCspOrigins],
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
// API работает на JSON; urlencoded — с лимитом и extended:false (без вложенных
// объектов через qs) — меньше поверхность атаки и не растёт без ограничения.
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());
app.use(visitorIdentityMiddleware);
app.use(ensureCsrfToken);
app.use(csrfProtection);

const formLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const registrationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 6,
  skip: () => env.NODE_ENV === 'test',
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Слишком много регистраций. Попробуйте позже.' },
});

const registrationEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skip: () => env.NODE_ENV === 'test',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (email.includes('@')) {
      return `email:${email}`;
    }
    return `ip:${ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? '0.0.0.0')}`;
  },
  message: { ok: false, error: 'Слишком много попыток с этим email. Попробуйте позже.' },
});

const participantLoginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (email.includes('@')) {
      return `participant-email:${email}`;
    }
    return `participant-ip:${ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? '0.0.0.0')}`;
  },
  message: {
    ok: true,
    message: 'Если этот email зарегистрирован, мы отправим одноразовую ссылку для входа.',
  },
});

const platformLoginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (email.includes('@')) {
      return `platform-email:${email}`;
    }
    return `platform-ip:${ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? '0.0.0.0')}`;
  },
  message: {
    ok: true,
    message: 'Если аккаунт доступен, мы отправим одноразовую ссылку для входа.',
  },
});

const platformMutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  skip: () => env.NODE_ENV === 'test',
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

app.use('/api/register', registrationLimiter);
app.use('/api/register', registrationEmailLimiter);
app.use('/api/register', formLimiter);
app.use('/api/participant/login/request', participantLoginEmailLimiter);
app.use('/api/participant/login/request', formLimiter);
app.use('/api/participant/login/consume', tokenReadLimiter);
app.use('/api/participant/access', tokenReadLimiter);
app.use('/api/participant/logout', formLimiter);
app.use('/api/v1/auth/passwordless/request', platformLoginEmailLimiter);
app.use('/api/v1/auth/passwordless/request', platformMutationLimiter);
app.use('/api/v1/auth/passwordless/consume', tokenReadLimiter);
app.use('/api/v1/auth', platformMutationLimiter);
app.use('/api/v1/organization', platformMutationLimiter);
app.use('/api/v1/creator', platformMutationLimiter);
app.use('/api/questions', formLimiter);
app.use('/api/partner-application', formLimiter);
app.use('/api/events', eventLimiter);
app.use('/api/telegram-click', eventLimiter);
app.use('/api/registration', tokenReadLimiter);
app.use('/api/webinar/current', tokenReadLimiter);
app.use('/api/webinar/timeline', tokenReadLimiter);
app.use('/api/webinar/chat', tokenReadLimiter);
app.use('/api/recordings', tokenReadLimiter);
app.use(
  '/api/media',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.use('/api/admin/login', adminLoginLimiter);
app.use('/api/admin/telegram/broadcast', adminBroadcastLimiter);

app.use('/api', publicRouter);
app.use(adminRouter);

app.get('/metrics', async (_req, res, next) => {
  try {
    if (!requireProductionMetricsToken(_req, res)) {
      return;
    }
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
// Публичный endpoint возвращает только aggregate status. Название сломанного
// контура и диагностические данные доступны только через token-protected details.
const dependencyHealthLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
});
app.get('/health/dependencies', dependencyHealthLimiter, async (_req, res, next) => {
  try {
    const summary = await getDependencySummary();
    res.setHeader('Cache-Control', 'no-store');
    res.status(summary.ok ? 200 : 503).json(summary);
  } catch (error) {
    next(error);
  }
});
app.get('/health/dependencies/details', dependencyHealthLimiter, async (req, res, next) => {
  try {
    if (!requireProductionMetricsToken(req, res)) return;
    const dependencies = await getCachedDependencyStatus();
    res.setHeader('Cache-Control', 'no-store');
    res.status(dependencies.ok ? 200 : 503).json({ service: 'aspb-autowebinar', ...dependencies });
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
app.get('/sitemap.xml', async (_req, res, next) => {
  try {
    if (!getPlatformFeatureFlags().publicCatalog) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    const entries = await listCatalogSitemapEntries(prisma);
    const origin = new URL(env.PUBLIC_SITE_URL).origin;
    const escapeXml = (value: string) =>
      value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const urls = [
      { path: '/crisis_premium/catalog.html', updatedAt: null as Date | null },
      ...entries.map(entry => ({
        path: `/crisis_premium/catalog-webinar.html?${new URLSearchParams({
          organization: entry.organization_slug,
          webinar: entry.webinar_slug,
        }).toString()}`,
        updatedAt: entry.updated_at,
      })),
    ];
    const body = urls
      .map(
        item =>
          `<url><loc>${escapeXml(new URL(item.path, origin).toString())}</loc>${
            item.updatedAt ? `<lastmod>${item.updatedAt.toISOString()}</lastmod>` : ''
          }</url>`,
      )
      .join('');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res
      .type('application/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`,
      );
  } catch (error) {
    next(error);
  }
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
<li>Ops endpoints: <code>/health/live</code>, <code>/health/ready</code>, public summary <code>/health/dependencies</code>, protected <code>/health/dependencies/details</code>, <code>/metrics</code>.</li>
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
app.use('/vendor/hls.js', express.static(path.join(rootDir, 'node_modules', 'hls.js', 'dist'), staticOptions));
app.use((req, res, next) => {
  let pathname = req.path;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    res.status(400).json({ ok: false, error: 'Invalid path' });
    return;
  }

  if (/\.(?:mp4|webm|mov|m3u8|m4s|ts)$/i.test(pathname)) {
    res.status(404).json({ ok: false, error: 'Media is available through participant access only' });
    return;
  }
  next();
});
app.use('/crisis_premium', express.static(frontendDir, staticOptions));
app.use(express.static(frontendDir, staticOptions));

app.get('/', (_req, res) => {
  res.redirect('/crisis_premium/index.html');
});

app.use(errorMiddleware);
