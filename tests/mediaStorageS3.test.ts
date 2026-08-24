import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { getMediaUploadBrowserContract } from '../src/lib/mediaStorage.js';
import { S3CompatibleMediaStorage } from '../src/lib/mediaStorageS3.js';

describe('S3-compatible private media adapter', () => {
  it('exposes a provider-neutral direct-upload CORS contract without storage authority', () => {
    const contract = getMediaUploadBrowserContract('s3');
    expect(contract).toMatchObject({
      transport: 'direct_object_storage',
      method: 'PUT',
      credentials: 'omit',
      requestHeaders: ['content-type'],
      responseHeaders: ['etag'],
      fullFileProxy: false,
    });
    expect(contract.signedOperationTtlSeconds).toBeGreaterThan(0);
    expect(JSON.stringify(contract)).not.toMatch(/bucket|storageKey|originUrl|secret/i);
    expect(getMediaUploadBrowserContract('local_fs')).toMatchObject({
      transport: 'api_compatibility',
      fullFileProxy: true,
    });
  });

  it('paginates provider ListParts and normalizes ETags', async () => {
    const send = vi.fn(async (command: { constructor: { name: string }; input: { PartNumberMarker?: string } }) => {
      expect(command.constructor.name).toBe('ListPartsCommand');
      if (!command.input.PartNumberMarker) {
        return {
          Parts: [{ PartNumber: 1, ETag: '"etag-one"' }],
          IsTruncated: true,
          NextPartNumberMarker: '1',
        };
      }
      return { Parts: [{ PartNumber: 2, ETag: 'etag-two' }], IsTruncated: false };
    });
    const adapter = new S3CompatibleMediaStorage({ send } as never, 'private-media');
    await expect(
      adapter.listMultipartUploadParts({
        providerUploadKey: 'upload-1',
        storageKey: 'source/video.mp4',
      }),
    ).resolves.toEqual([
      { partNumber: 1, etag: 'etag-one' },
      { partNumber: 2, etag: 'etag-two' },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a provider-committed upload from a transient ListParts failure', async () => {
    const send = vi.fn().mockRejectedValue(
      Object.assign(new Error('not exposed'), {
        name: 'NoSuchUpload',
        $metadata: { httpStatusCode: 404 },
      }),
    );
    const adapter = new S3CompatibleMediaStorage({ send } as never, 'private-media');
    await expect(
      adapter.listMultipartUploadParts({
        providerUploadKey: 'already-complete',
        storageKey: 'source/video.mp4',
      }),
    ).rejects.toMatchObject({ safeCode: 'media_upload_already_completed' });
  });

  it('treats an already completed provider upload as idempotent after HeadObject verification', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('not exposed'), {
          name: 'NoSuchUpload',
          $metadata: { httpStatusCode: 404 },
        }),
      )
      .mockResolvedValueOnce({ ContentType: 'video/mp4', ContentLength: 1024 });
    const adapter = new S3CompatibleMediaStorage({ send } as never, 'private-media');
    await expect(
      adapter.completeMultipartUpload({
        providerUploadKey: 'completed-upload',
        storageKey: 'source/video.mp4',
        parts: [{ partNumber: 1, etag: 'etag' }],
        expectedMimeType: 'video/mp4',
        expectedSizeBytes: 1024n,
      }),
    ).resolves.toEqual({ mimeType: 'video/mp4', sizeBytes: 1024n });
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      'CompleteMultipartUploadCommand',
      'HeadObjectCommand',
    ]);
  });

  it('preserves authorized Range metadata and maps an unsatisfiable provider range safely', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Body: Readable.from(Buffer.from('part')),
        ContentType: 'video/mp2t',
        ContentLength: 4,
        ContentRange: 'bytes 0-3/10',
      })
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 416 } });
    const adapter = new S3CompatibleMediaStorage({ send } as never, 'private-media');
    await expect(adapter.readObject({ storageKey: 'hls/segment.ts', range: 'bytes=0-3' })).resolves.toMatchObject({
      contentType: 'video/mp2t',
      contentLength: 4,
      contentRange: 'bytes 0-3/10',
    });
    await expect(adapter.readObject({ storageKey: 'hls/segment.ts', range: 'bytes=100-200' })).rejects.toMatchObject({
      statusCode: 416,
      code: 'media_range_invalid',
    });
  });

  it('exposes idempotent provider cleanup primitives without leaking object authority', async () => {
    const send = vi.fn().mockResolvedValue({});
    const adapter = new S3CompatibleMediaStorage({ send } as never, 'private-media');
    await expect(
      adapter.abortMultipartUpload({ providerUploadKey: 'upload-test', storageKey: 'synthetic/object.bin' }),
    ).resolves.toBeUndefined();
    await expect(adapter.deleteObject({ storageKey: 'synthetic/object.bin' })).resolves.toBeUndefined();
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      'AbortMultipartUploadCommand',
      'DeleteObjectCommand',
    ]);
  });
});
