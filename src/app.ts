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
import { csrfProtection, ensureCsrfToken } from './lib/csrf.js';
import { cspStyleAttributeHashes, cspStyleElementHashes } from './lib/cspInlineHashes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const frontendDir = path.join(rootDir, 'crisis_premium');

export const app = express();

app.set('trust proxy', 1);
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

app.get('/.well-known/security.txt', (_req, res) => {
  res.type('text/plain').sendFile(path.join(frontendDir, '.well-known', 'security.txt'), { dotfiles: 'allow' });
});
app.use('/crisis_premium', express.static(frontendDir));
app.use(express.static(frontendDir));

app.get('/', (_req, res) => {
  res.redirect('/crisis_premium/index.html');
});

app.use(errorMiddleware);
