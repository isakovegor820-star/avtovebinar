import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const ordinaryLeadTransactionFiles = [
  'src/routes/public/registration.ts',
  'src/routes/public/helpers.ts',
  'src/routes/public/partners.ts',
  'src/routes/admin.ts',
  'src/lib/aiManager.ts',
  'src/lib/reminders.ts',
];

describe('channel-specific provider lock architecture', () => {
  it.each(ordinaryLeadTransactionFiles)('%s does not acquire a provider delivery lock', file => {
    const source = readFileSync(file, 'utf8');

    expect(source).not.toContain('acquireEmailDeliveryLock');
    expect(source).not.toContain('acquireTelegramDeliveryLock');
  });

  it('keeps provider locks scoped to delivery, revocation and erasure boundaries', () => {
    const emailOutbox = readFileSync('src/lib/emailOutbox.ts', 'utf8');
    const telegramWorker = readFileSync('src/lib/telegramBroadcastWorker.ts', 'utf8');
    const telegramBot = readFileSync('src/lib/telegramParticipantBot.ts', 'utf8');
    const anonymization = readFileSync('src/lib/anonymizeLead.ts', 'utf8');

    expect(emailOutbox).toContain('await acquireEmailDeliveryLock(tx, registrationRef.leadId)');
    expect(telegramWorker).toContain('await acquireTelegramDeliveryLock(tx, recipientRef.leadId)');
    expect(telegramBot).toContain('await acquireTelegramDeliveryLock(tx, lead.id)');
    expect(anonymization).toContain('await acquireEmailDeliveryLock(tx, input.leadId)');
    expect(anonymization).toContain('await acquireTelegramDeliveryLock(tx, input.leadId)');
  });
});
