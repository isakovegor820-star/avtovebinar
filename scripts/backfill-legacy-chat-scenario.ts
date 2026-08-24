import { prisma } from '../src/lib/prisma.js';
import { SCRIPTED_CHAT_SCENARIO } from '../src/lib/scriptedChat.js';
import {
  backfillLegacyChatScenario,
  compareLegacyChatScenarioShadow,
} from '../src/lib/tenancy/chatScenarioBackfill.js';

const apply = process.argv.includes('--apply');
const compare = process.argv.includes('--compare');

try {
  const report = compare
    ? await compareLegacyChatScenarioShadow(prisma, SCRIPTED_CHAT_SCENARIO)
    : await backfillLegacyChatScenario(prisma, SCRIPTED_CHAT_SCENARIO, { apply });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (compare && !report.matches) process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
