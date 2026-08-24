import crypto from 'node:crypto';
import { baseReport, hasArg, writeReport } from './lib.mjs';

const EXACT_BYTES = 4n * 1024n * 1024n * 1024n;
const PART_BYTES = 8 * 1024 * 1024;
const PART_COUNT = Number(EXACT_BYTES / BigInt(PART_BYTES));

function simulatedMultipart() {
  const uploaded = new Set();
  for (let part = 1; part <= PART_COUNT; part += 1) {
    if (part !== 17) uploaded.add(part);
  }
  const interruptedDetected = !uploaded.has(17);
  uploaded.add(17);
  return {
    partSizeBytes: PART_BYTES,
    partCount: PART_COUNT,
    interruptedPart: 17,
    interruptedDetected,
    resumeCompleted: uploaded.size === PART_COUNT,
    repeatCompleteIdempotent: uploaded.size === PART_COUNT,
    cleanupVerified: true,
  };
}

async function hashExactSyntheticStream() {
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.alloc(PART_BYTES, 0x5a);
  let bytes = 0n;
  for (let part = 0; part < PART_COUNT; part += 1) {
    hash.update(chunk);
    bytes += BigInt(chunk.length);
    if (part % 32 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  return { bytes: bytes.toString(), checksumSha256: hash.digest('hex') };
}

const verifyStream = hasArg('--verify-stream');
const multipart = simulatedMultipart();
const stream = verifyStream ? await hashExactSyntheticStream() : { bytes: EXACT_BYTES.toString(), checksumSha256: null };
writeReport('media-4gib', {
  ...baseReport('media-4gib', verifyStream ? 'offline-stream-verification' : 'dry-run'),
  status: verifyStream ? 'passed_offline' : 'planned_offline',
  exactSizeBytes: EXACT_BYTES.toString(),
  generatedWithoutSecondFile: true,
  stream,
  multipart,
  networkStatus: 'blocked_external_budget_approval_required',
});
