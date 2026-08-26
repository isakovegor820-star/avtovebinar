import { lstat, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFilesystemMediaStorage } from '../src/lib/mediaStorageLocal.js';

const roots: string[] = [];
const applicationUploadId = '11111111-1111-4111-8111-111111111111';
const storageKey = 'organizations/tenant-a/webinars/webinar-a/assets/asset-a/source';

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'aspb-local-media-test-'));
  roots.push(root);
  return root;
}

async function bodyText(body: Readable) {
  const chunks: Buffer[] = [];
  for await (const value of body) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  return Buffer.concat(chunks).toString('utf8');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('self-hosted private media storage', () => {
  it('persists resumable checkpoints across adapter restarts and serves authorized ranges', async () => {
    const root = await temporaryRoot();
    const firstAdapter = new LocalFilesystemMediaStorage(root);
    const created = await firstAdapter.createMultipartUpload({
      applicationUploadId,
      storageKey,
      mimeType: 'video/mp4',
      partCount: 2,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(created.partUrls).toEqual([
      expect.objectContaining({
        partNumber: 1,
        url: `/api/v1/creator/uploads/${applicationUploadId}/parts/1/content`,
      }),
      expect.objectContaining({
        partNumber: 2,
        url: `/api/v1/creator/uploads/${applicationUploadId}/parts/2/content`,
      }),
    ]);
    expect(JSON.stringify(created)).not.toContain(storageKey);

    const first = await firstAdapter.writeMultipartUploadPart({
      applicationUploadId,
      providerUploadKey: created.providerUploadKey,
      storageKey,
      partNumber: 1,
      expectedSizeBytes: 5,
      body: Readable.from(Buffer.from('hello')),
    });
    const second = await firstAdapter.writeMultipartUploadPart({
      applicationUploadId,
      providerUploadKey: created.providerUploadKey,
      storageKey,
      partNumber: 2,
      expectedSizeBytes: 5,
      body: Readable.from(Buffer.from('world')),
    });
    expect(first.etag).toMatch(/^[0-9a-f]{64}$/);

    const restartedAdapter = new LocalFilesystemMediaStorage(root);
    await expect(
      restartedAdapter.listMultipartUploadParts({ providerUploadKey: created.providerUploadKey, storageKey }),
    ).resolves.toEqual([
      { partNumber: 1, etag: first.etag, sizeBytes: 5, checksumSha256: first.etag },
      { partNumber: 2, etag: second.etag, sizeBytes: 5, checksumSha256: second.etag },
    ]);
    await expect(
      restartedAdapter.completeMultipartUpload({
        providerUploadKey: created.providerUploadKey,
        storageKey,
        parts: [
          { partNumber: 1, etag: `"${first.etag}"` },
          { partNumber: 2, etag: second.etag },
        ],
        expectedMimeType: 'video/mp4',
        expectedSizeBytes: 10n,
      }),
    ).resolves.toEqual({ mimeType: 'video/mp4', sizeBytes: 10n });

    const full = await restartedAdapter.readObject({ storageKey });
    expect(await bodyText(full.body)).toBe('helloworld');
    expect(full).toMatchObject({ contentType: 'video/mp4', contentLength: 10 });
    const range = await restartedAdapter.readObject({ storageKey, range: 'bytes=-5' });
    expect(await bodyText(range.body)).toBe('world');
    expect(range).toMatchObject({ contentLength: 5, contentRange: 'bytes 5-9/10' });
    await expect(restartedAdapter.readObject({ storageKey, range: 'bytes=10-12' })).rejects.toMatchObject({
      statusCode: 416,
      code: 'media_range_invalid',
    });
    await expect(
      restartedAdapter.completeMultipartUpload({
        providerUploadKey: created.providerUploadKey,
        storageKey,
        parts: [
          { partNumber: 1, etag: first.etag },
          { partNumber: 2, etag: second.etag },
        ],
        expectedMimeType: 'video/mp4',
        expectedSizeBytes: 10n,
      }),
    ).resolves.toEqual({ mimeType: 'video/mp4', sizeBytes: 10n });

    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    const dataPath = join(root, 'objects', ...storageKey.split('/'), 'data');
    expect((await lstat(dataPath)).mode & 0o777).toBe(0o600);
    await expect(restartedAdapter.getCapacity()).resolves.toMatchObject({
      totalBytes: expect.any(BigInt),
      availableBytes: expect.any(BigInt),
      totalInodes: expect.any(BigInt),
      availableInodes: expect.any(BigInt),
    });
  });

  it('rejects conflicting retries, truncated parts and corrupted checkpoints before publication', async () => {
    const root = await temporaryRoot();
    const adapter = new LocalFilesystemMediaStorage(root);
    const created = await adapter.createMultipartUpload({
      applicationUploadId,
      storageKey,
      mimeType: 'video/mp4',
      partCount: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      adapter.writeMultipartUploadPart({
        applicationUploadId,
        providerUploadKey: created.providerUploadKey,
        storageKey,
        partNumber: 1,
        expectedSizeBytes: 5,
        body: Readable.from(Buffer.from('tiny')),
      }),
    ).rejects.toMatchObject({ safeCode: 'media_upload_part_size_mismatch' });
    const written = await adapter.writeMultipartUploadPart({
      applicationUploadId,
      providerUploadKey: created.providerUploadKey,
      storageKey,
      partNumber: 1,
      expectedSizeBytes: 5,
      body: Readable.from(Buffer.from('first')),
    });
    await expect(
      adapter.writeMultipartUploadPart({
        applicationUploadId,
        providerUploadKey: created.providerUploadKey,
        storageKey,
        partNumber: 1,
        expectedSizeBytes: 5,
        body: Readable.from(Buffer.from('other')),
      }),
    ).rejects.toMatchObject({ safeCode: 'media_upload_part_conflict' });

    const uploadDirectory = join(root, 'multipart', created.providerUploadKey);
    const partName = (await readdir(uploadDirectory)).find(name => name.endsWith(`${written.etag}.part`));
    expect(partName).toEqual(expect.any(String));
    await writeFile(join(uploadDirectory, partName!), 'wrong', { mode: 0o600 });
    await expect(
      adapter.completeMultipartUpload({
        providerUploadKey: created.providerUploadKey,
        storageKey,
        parts: [{ partNumber: 1, etag: written.etag }],
        expectedMimeType: 'video/mp4',
        expectedSizeBytes: 5n,
      }),
    ).rejects.toMatchObject({ safeCode: 'media_upload_part_integrity_failed' });
  });

  it('fails closed for traversal, symlink roots and aborted uploads', async () => {
    const root = await temporaryRoot();
    const adapter = new LocalFilesystemMediaStorage(root);
    await expect(
      adapter.createMultipartUpload({
        applicationUploadId,
        storageKey: '../outside/source',
        mimeType: 'video/mp4',
        partCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ safeCode: 'media_storage_key_invalid' });

    const created = await adapter.createMultipartUpload({
      applicationUploadId,
      storageKey,
      mimeType: 'video/mp4',
      partCount: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await adapter.abortMultipartUpload({ providerUploadKey: created.providerUploadKey, storageKey });
    await expect(
      adapter.listMultipartUploadParts({ providerUploadKey: created.providerUploadKey, storageKey }),
    ).rejects.toMatchObject({ safeCode: 'media_upload_reconciliation_failed' });

    const outsideObjects = await temporaryRoot();
    await symlink(outsideObjects, join(root, 'objects', 'organizations'), 'dir');
    await expect(
      adapter.createMultipartUpload({
        applicationUploadId,
        storageKey,
        mimeType: 'video/mp4',
        partCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ safeCode: 'media_storage_path_invalid' });

    const symlinkTarget = await temporaryRoot();
    const symlinkRoot = join(await temporaryRoot(), 'linked-media');
    await symlink(symlinkTarget, symlinkRoot, 'dir');
    const symlinkAdapter = new LocalFilesystemMediaStorage(symlinkRoot);
    await expect(symlinkAdapter.checkReady()).resolves.toBe(false);
  });
});
