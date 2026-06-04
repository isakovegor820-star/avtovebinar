import pino from 'pino';
import { env } from './env.js';
import { getRequestContext } from './requestContext.js';

export const logger = (pino as unknown as typeof pino.default)({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const context = getRequestContext();
    if (!context) {
      return {};
    }

    return {
      correlation_id: context.correlationId,
      userId: context.userId ?? undefined,
      adminId: context.adminId ?? undefined,
    };
  },
});
