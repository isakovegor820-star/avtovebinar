import { Router } from 'express';
import { registrationRouter } from './public/registration.js';
import { webinarRouter } from './public/webinar.js';
import { recordingsRouter } from './public/recordings.js';
import { eventsRouter } from './public/events.js';
import { partnersRouter } from './public/partners.js';
import { mediaRouter } from './public/media.js';
import { sendCsrfToken } from '../lib/csrf.js';
import { getReadiness } from '../lib/health.js';

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

publicRouter.get('/csrf', sendCsrfToken);

// Sub-routers (all paths are defined inside each module)
publicRouter.use(registrationRouter);
publicRouter.use(webinarRouter);
publicRouter.use(recordingsRouter);
publicRouter.use(eventsRouter);
publicRouter.use(partnersRouter);
publicRouter.use(mediaRouter);
