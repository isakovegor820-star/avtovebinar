import { logger } from './logger.js';

type CircuitState = {
  failures: number;
  openedUntil: number;
};

const circuits = new Map<string, CircuitState>();

export function normalizeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function retryDelayMs(
  attempt: number,
  input?: { baseMs?: number; maxMs?: number; retryAfterMs?: number | null },
) {
  if (input?.retryAfterMs && input.retryAfterMs > 0) {
    return input.retryAfterMs;
  }

  const baseMs = input?.baseMs ?? 1000;
  const maxMs = input?.maxMs ?? 60_000;
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(1000, Math.max(100, exponential / 4)));
  return exponential + jitter;
}

export function getCircuitState(name: string) {
  const state = circuits.get(name) ?? { failures: 0, openedUntil: 0 };
  return {
    name,
    failures: state.failures,
    open: state.openedUntil > Date.now(),
    openedUntil: state.openedUntil ? new Date(state.openedUntil).toISOString() : null,
  };
}

export function isCircuitOpen(name: string) {
  return getCircuitState(name).open;
}

export async function withCircuitBreaker<T>(
  name: string,
  task: () => Promise<T>,
  options: { failureThreshold?: number; cooldownMs?: number } = {},
) {
  const state = circuits.get(name) ?? { failures: 0, openedUntil: 0 };
  const now = Date.now();
  if (state.openedUntil > now) {
    throw new Error(`${name} circuit breaker is open until ${new Date(state.openedUntil).toISOString()}`);
  }

  try {
    const result = await task();
    circuits.set(name, { failures: 0, openedUntil: 0 });
    return result;
  } catch (error) {
    const failures = state.failures + 1;
    const threshold = options.failureThreshold ?? 3;
    const cooldownMs = options.cooldownMs ?? 60_000;
    const openedUntil = failures >= threshold ? now + cooldownMs : 0;
    circuits.set(name, { failures, openedUntil });
    if (openedUntil) {
      logger.warn(
        { circuit: name, failures, openedUntil: new Date(openedUntil).toISOString() },
        'Circuit breaker opened',
      );
    }
    throw error;
  }
}

export async function withRetries<T>(
  name: string,
  task: () => Promise<T>,
  options: {
    attempts?: number;
    baseMs?: number;
    maxMs?: number;
    retryAfterMs?: (error: unknown) => number | null;
  } = {},
) {
  const attempts = options.attempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        break;
      }

      const delay = retryDelayMs(attempt, {
        baseMs: options.baseMs,
        maxMs: options.maxMs,
        retryAfterMs: options.retryAfterMs?.(error),
      });
      logger.warn({ retry: name, attempt, delayMs: delay, error: normalizeError(error) }, 'Retrying failed operation');
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
