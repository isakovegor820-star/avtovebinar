import { describe, expect, it } from 'vitest';
import { materialDeleteSchema, materialUploadCreateSchema } from '../src/lib/tenancy/webinarMaterials.js';

describe('private Webinar material contracts', () => {
  it('accepts an allowlisted file and converts its size to bigint', () => {
    const parsed = materialUploadCreateSchema.parse({
      displayName: 'Памятка участника',
      fileName: 'checklist.pdf',
      mimeType: 'application/pdf',
      sizeBytes: '4096',
      checksumSha256: 'a'.repeat(64),
      idempotencyKey: 'material-upload:1',
    });
    expect(parsed.sizeBytes).toBe(4096n);
  });

  it('is strict and requires optimistic revision on removal', () => {
    expect(() =>
      materialUploadCreateSchema.parse({
        displayName: 'Памятка участника',
        fileName: 'checklist.pdf',
        mimeType: 'application/pdf',
        sizeBytes: '4096',
        idempotencyKey: 'material-upload:1',
        storageKey: 'forged',
      }),
    ).toThrow();
    expect(materialDeleteSchema.parse({ expectedRevision: 2 })).toEqual({ expectedRevision: 2 });
  });
});
