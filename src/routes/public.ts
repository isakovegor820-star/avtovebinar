import { Router } from 'express';
import { registrationRouter } from './public/registration.js';
import { webinarRouter } from './public/webinar.js';
import { recordingsRouter } from './public/recordings.js';
import { eventsRouter } from './public/events.js';
import { partnersRouter } from './public/partners.js';
import rateLimit from 'express-rate-limit';
import { sendCsrfToken } from '../lib/csrf.js';
import { getDependencyStatus, getReadiness } from '../lib/health.js';

export const publicRouter = Router();

// Re-export registerSchema for tests
export { registerSchema } from './public/registration.js';

publicRouter.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'aspb-autowebinar' });
});

publicRouter.get('/health/live', (_req, res) => {
  res.json({ ok: true, service: 'aspb-autowebinar' });
});

publicRouter.get('/health/ready', async (_req, res, next) => {
  try {
    const readiness = await getReadiness();
    res.status(readiness.ok ? 200 : 503).json({ service: 'aspb-autowebinar', ...readiness });
  } catch (error) {
    next(error);
  }
});

// /health/dependencies дёргает SMTP и Telegram API — без лимита аноним может довести
// внешние сервисы до блокировки нашего IP (тот же лимит 12/мин, что и на ops-роуте в app.ts).
const dependencyHealthLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
});

publicRouter.get('/health/dependencies', dependencyHealthLimiter, async (_req, res, next) => {
  try {
    const dependencies = await getDependencyStatus();
    res.status(dependencies.ok ? 200 : 503).json({ service: 'aspb-autowebinar', ...dependencies });
  } catch (error) {
    next(error);
  }
});

publicRouter.get('/csrf', sendCsrfToken);

// Sub-routers (all paths are defined inside each module)
publicRouter.use(registrationRouter);
publicRouter.use(webinarRouter);
publicRouter.use(recordingsRouter);
publicRouter.use(eventsRouter);
publicRouter.use(partnersRouter);
