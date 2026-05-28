import { Router } from 'express';
import { registrationRouter } from './public/registration.js';
import { webinarRouter } from './public/webinar.js';
import { eventsRouter } from './public/events.js';
import { partnersRouter } from './public/partners.js';

export const publicRouter = Router();

// Re-export registerSchema for tests
export { registerSchema } from './public/registration.js';

// Health check
publicRouter.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'aspb-autowebinar' });
});

// Sub-routers (all paths are defined inside each module)
publicRouter.use(registrationRouter);
publicRouter.use(webinarRouter);
publicRouter.use(eventsRouter);
publicRouter.use(partnersRouter);
