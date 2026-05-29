import pino from 'pino';
import { env } from './env.js';

export const logger = (pino as unknown as typeof pino.default)({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  timestamp: pino.stdTimeFunctions.isoTime,
});
