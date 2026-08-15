// A due message should normally be claimed on the next one-minute worker tick.
// Five missed ticks are treated as an operational SLA breach, while the job
// remains retryable and visible to the protected dependency endpoint.
export const EMAIL_OUTBOX_DUE_PENDING_SLA_MS = 5 * 60 * 1000;

// A single SMTP delivery has a hard 55-second budget. Ten minutes leaves ample
// room for finalization and scheduler jitter without hiding an abandoned lease.
export const EMAIL_OUTBOX_STALE_SENDING_MS = 10 * 60 * 1000;
