import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertExpectedDuration,
  probeHlsSource,
  probeLocalMp4Duration,
  probeRemoteMp4Duration,
  resolveVideoCheckConfig,
} from '../scripts/check-webinar-video.mjs';

const temporaryDirectories: string[] = [];

function makeMpegTsProbe() {
  const mpeg2Crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc = (crc ^ (byte << 24)) >>> 0;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
      }
    }
    return crc >>> 0;
  };
  const withCrc = (sectionWithoutCrc: Buffer) => {
    const section = Buffer.alloc(sectionWithoutCrc.length + 4);
    sectionWithoutCrc.copy(section);
    section.writeUInt32BE(mpeg2Crc32(sectionWithoutCrc), sectionWithoutCrc.length);
    return section;
  };
  const packet = (pid: number, payloadUnitStart: boolean, payload: Buffer, continuity: number) => {
    const value = Buffer.alloc(188, 0xff);
    value[0] = 0x47;
    value[1] = ((pid >> 8) & 0x1f) | (payloadUnitStart ? 0x40 : 0);
    value[2] = pid & 0xff;
    value[3] = 0x10 | (continuity & 0x0f);
    payload.copy(value, 4, 0, Math.min(payload.length, 184));
    return value;
  };
  const pat = Buffer.concat([
    Buffer.from([0x00]),
    withCrc(Buffer.from([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe1, 0x00])),
  ]);
  const pmt = Buffer.concat([
    Buffer.from([0x00]),
    withCrc(
      Buffer.from([
        0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00, 0x1b, 0xe1, 0x01, 0xf0, 0x00,
      ]),
    ),
  ]);
  const videoPes = Buffer.from([0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x01, 0x65, 0x88]);
  return Buffer.concat([packet(0, true, pat, 0), packet(0x100, true, pmt, 0), packet(0x101, true, videoPes, 0)]);
}

function isoBox(type: string, payload: Buffer) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 'ascii');
  payload.copy(box, 8);
  return box;
}

function makeStructuredMp4(durationSeconds = 3860) {
  const ftypPayload = Buffer.alloc(12);
  ftypPayload.write('isom', 0, 'ascii');
  ftypPayload.writeUInt32BE(0x200, 4);
  ftypPayload.write('isom', 8, 'ascii');
  const mvhdPayload = Buffer.alloc(100);
  mvhdPayload[0] = 0;
  mvhdPayload.writeUInt32BE(1, 12);
  mvhdPayload.writeUInt32BE(durationSeconds, 16);
  const tkhdPayload = Buffer.alloc(84);
  tkhdPayload.writeUInt32BE(1, 12);
  const mdhdPayload = Buffer.alloc(24);
  mdhdPayload.writeUInt32BE(1, 12);
  mdhdPayload.writeUInt32BE(durationSeconds, 16);
  const hdlrPayload = Buffer.alloc(24);
  hdlrPayload.write('vide', 8, 'ascii');
  const sampleEntry = isoBox('avc1', Buffer.alloc(78));
  const stsdHeader = Buffer.alloc(8);
  stsdHeader.writeUInt32BE(1, 4);
  const stsd = isoBox('stsd', Buffer.concat([stsdHeader, sampleEntry]));
  const stbl = isoBox('stbl', stsd);
  const minf = isoBox('minf', stbl);
  const mdia = isoBox('mdia', Buffer.concat([isoBox('mdhd', mdhdPayload), isoBox('hdlr', hdlrPayload), minf]));
  const trak = isoBox('trak', Buffer.concat([isoBox('tkhd', tkhdPayload), mdia]));
  return Buffer.concat([
    isoBox('ftyp', ftypPayload),
    isoBox('moov', Buffer.concat([isoBox('mvhd', mvhdPayload), trak])),
    isoBox('mdat', Buffer.alloc(32, 0xaa)),
  ]);
}

function makeStructuredFragmentedMp4() {
  const mfhdPayload = Buffer.alloc(8);
  mfhdPayload.writeUInt32BE(1, 4);
  const tfhdPayload = Buffer.alloc(8);
  tfhdPayload.writeUInt32BE(1, 4);
  const trunPayload = Buffer.alloc(8);
  trunPayload.writeUInt32BE(1, 4);
  const mfhd = isoBox('mfhd', mfhdPayload);
  const tfhd = isoBox('tfhd', tfhdPayload);
  const trun = isoBox('trun', trunPayload);
  const traf = isoBox('traf', Buffer.concat([tfhd, trun]));
  return Buffer.concat([isoBox('moof', Buffer.concat([mfhd, traf])), isoBox('mdat', Buffer.alloc(32, 0xbb))]);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('configured webinar video check', () => {
  it('uses the production HLS source before MP4 and the 3860-second default', () => {
    const config = resolveVideoCheckConfig({
      environment: {
        VIDEO_ENV_FILE: '/missing-test-env',
        PUBLIC_SITE_URL: 'https://example.com',
        WEBINAR_VIDEO_HLS_URL: 'https://private.example.com/master.m3u8',
        WEBINAR_VIDEO_URL: 'https://private.example.com/video.mp4',
      },
      cwd: process.cwd(),
    });

    expect(config).toMatchObject({
      sourceKind: 'HLS',
      probeSource: 'https://private.example.com/master.m3u8',
      expectedDurationSeconds: 3860,
    });
  });

  it('rejects the obsolete 568-second asset against the configured duration', () => {
    expect(() => assertExpectedDuration(568, 3860, 5)).toThrow(/expected 3860s/);
    expect(() => assertExpectedDuration(3858.5, 3860, 5)).not.toThrow();
  });

  it('refuses to send a private-origin token over plain HTTP', () => {
    expect(() =>
      resolveVideoCheckConfig({
        environment: {
          VIDEO_ENV_FILE: '/missing-test-env',
          WEBINAR_VIDEO_URL: 'http://private.example.com/video.mp4',
          WEBINAR_MEDIA_ORIGIN_TOKEN: 'private-origin-token',
        },
        cwd: process.cwd(),
      }),
    ).toThrow(/must use HTTPS/);
  });

  it('opens a playable HLS variant and probes its first and last segments with private-origin auth', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchMock = async (input: string | URL | globalThis.Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith('/master.m3u8')) {
        return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvariant/index.m3u8\n');
      }
      if (url.endsWith('/variant/index.m3u8')) {
        return new Response('#EXTM3U\n#EXTINF:1900,\nfirst.ts\n#EXTINF:1960,\nlast.ts\n#EXT-X-ENDLIST\n');
      }
      if (url.endsWith('.ts')) return new Response(makeMpegTsProbe());
      return new Response(null, { status: 404 });
    };

    await expect(
      probeHlsSource('https://private.example/master.m3u8', 'private-origin-token', fetchMock as typeof fetch),
    ).resolves.toBe(3860);
    const segmentCalls = calls.filter(call => call.url.endsWith('.ts'));
    expect(segmentCalls.map(call => call.url)).toEqual([
      'https://private.example/variant/first.ts',
      'https://private.example/variant/last.ts',
    ]);
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBe('Bearer private-origin-token');
    }
    for (const call of segmentCalls) {
      expect(call.headers.get('range')).toBe('bytes=0-65535');
    }
  });

  it('does not forward private-origin auth to an absolute cross-origin HLS child', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock = async (input: string | URL | globalThis.Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      if (url === 'https://private.example/master.m3u8') {
        return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nhttps://cdn.example/variant.m3u8\n');
      }
      if (url === 'https://cdn.example/variant.m3u8') {
        return new Response('#EXTM3U\n#EXTINF:3860,\nhttps://cdn.example/video.ts\n#EXT-X-ENDLIST\n');
      }
      if (url === 'https://cdn.example/video.ts') return new Response(makeMpegTsProbe());
      return new Response(null, { status: 404 });
    };

    await expect(
      probeHlsSource('https://private.example/master.m3u8', 'private-origin-token', fetchMock as typeof fetch),
    ).resolves.toBe(3860);
    expect(calls).toEqual([
      { url: 'https://private.example/master.m3u8', authorization: 'Bearer private-origin-token' },
      { url: 'https://cdn.example/variant.m3u8', authorization: null },
      { url: 'https://cdn.example/video.ts', authorization: null },
    ]);
  });

  it('recomputes auth on redirects instead of forwarding the token cross-origin', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock = async (input: string | URL | globalThis.Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      if (url === 'https://private.example/master.m3u8') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example/media.m3u8' },
        });
      }
      if (url === 'https://cdn.example/media.m3u8') {
        return new Response('#EXTM3U\n#EXTINF:3860,\nvideo.ts\n#EXT-X-ENDLIST\n');
      }
      if (url === 'https://cdn.example/video.ts') return new Response(makeMpegTsProbe());
      return new Response(null, { status: 404 });
    };

    await expect(
      probeHlsSource('https://private.example/master.m3u8', 'private-origin-token', fetchMock as typeof fetch),
    ).resolves.toBe(3860);
    expect(calls).toEqual([
      { url: 'https://private.example/master.m3u8', authorization: 'Bearer private-origin-token' },
      { url: 'https://cdn.example/media.m3u8', authorization: null },
      { url: 'https://cdn.example/video.ts', authorization: null },
    ]);
  });

  it('caps HLS manifests at 1 MiB and rejects HTML returned for a media segment', async () => {
    const oversizedManifest = `#EXTM3U\n${'x'.repeat(1024 * 1024)}`;
    await expect(
      probeHlsSource(
        'https://private.example/oversized.m3u8',
        undefined,
        (async () => new Response(oversizedManifest)) as typeof fetch,
      ),
    ).rejects.toThrow(/exceeds 1 MiB/);

    const htmlFetch = async (input: string | URL | globalThis.Request) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) {
        return new Response('#EXTM3U\n#EXTINF:3860,\nsegment.ts\n#EXT-X-ENDLIST\n');
      }
      return new Response('<!doctype html><title>upstream error</title>');
    };
    await expect(
      probeHlsSource('https://private.example/media.m3u8', undefined, htmlFetch as typeof fetch),
    ).rejects.toThrow(/text instead of media/);
  });

  it('accepts structured fragmented MP4 segments and rejects sync-byte/string junk', async () => {
    const fragmentFetch = async (input: string | URL | globalThis.Request) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXTINF:3860,\nsegment.m4s\n#EXT-X-ENDLIST\n');
      return new Response(makeStructuredFragmentedMp4());
    };
    await expect(
      probeHlsSource('https://private.example/media.m3u8', undefined, fragmentFetch as typeof fetch),
    ).resolves.toBe(3860);

    const junk = Buffer.alloc(3 * 188);
    junk[0] = junk[188] = junk[376] = 0x47;
    junk.write('moof', 8, 'ascii');
    const junkFetch = async (input: string | URL | globalThis.Request) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXTINF:3860,\nsegment.ts\n#EXT-X-ENDLIST\n');
      return new Response(junk);
    };
    await expect(
      probeHlsSource('https://private.example/junk.m3u8', undefined, junkFetch as typeof fetch),
    ).rejects.toThrow(/no valid MPEG-TS PAT\/PMT or structured fragmented-MP4/);

    const hollowFragment = Buffer.concat([
      isoBox(
        'moof',
        Buffer.concat([
          isoBox('mfhd', Buffer.alloc(8)),
          isoBox('traf', Buffer.concat([isoBox('tfhd', Buffer.alloc(8)), isoBox('trun', Buffer.alloc(8))])),
        ]),
      ),
      isoBox('mdat', Buffer.alloc(16)),
    ]);
    const hollowFetch = async (input: string | URL | globalThis.Request) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXTINF:3860,\nsegment.m4s\n#EXT-X-ENDLIST\n');
      return new Response(hollowFragment);
    };
    await expect(
      probeHlsSource('https://private.example/hollow.m3u8', undefined, hollowFetch as typeof fetch),
    ).rejects.toThrow(/structured fragmented-MP4/);
  });

  it('rejects MPEG-TS with corrupted PAT provenance even when PIDs and PES look valid', async () => {
    const corrupted = makeMpegTsProbe();
    corrupted[4 + 12] ^= 0x01;
    const fetchMock = async (input: string | URL | globalThis.Request) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXTINF:3860,\nsegment.ts\n#EXT-X-ENDLIST\n');
      return new Response(corrupted);
    };
    await expect(
      probeHlsSource('https://private.example/corrupt.m3u8', undefined, fetchMock as typeof fetch),
    ).rejects.toThrow(/no valid MPEG-TS PAT\/PMT or structured fragmented-MP4/);
  });

  it('reads remote MP4 duration from a bounded authenticated metadata range', async () => {
    const mp4 = makeStructuredMp4();
    const fetchMock = async (_input: string | URL | globalThis.Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer private-origin-token');
      expect(headers.get('range')).toMatch(/^bytes=0-/);
      return new Response(mp4, {
        status: 206,
        headers: { 'content-range': `bytes 0-${mp4.length - 1}/${mp4.length}` },
      });
    };

    await expect(
      probeRemoteMp4Duration('https://private.example/video.mp4', 'private-origin-token', fetchMock as typeof fetch),
    ).resolves.toBe(3860);
  });

  it('rejects raw ftyp/mvhd byte sequences that are not structural ISO-BMFF boxes', async () => {
    const junk = Buffer.alloc(256);
    junk.write('ftyp', 4, 'ascii');
    junk.write('mvhd', 100, 'ascii');
    junk[104] = 0;
    junk.writeUInt32BE(1, 116);
    junk.writeUInt32BE(3860, 120);
    const fetchMock = async () =>
      new Response(junk, {
        status: 206,
        headers: { 'content-range': `bytes 0-${junk.length - 1}/${junk.length}` },
      });
    await expect(
      probeRemoteMp4Duration('https://private.example/junk.mp4', undefined, fetchMock as typeof fetch),
    ).rejects.toThrow(/ftyp/);
  });

  it('rejects boxed MP4 metadata with no structural video track', async () => {
    const ftypPayload = Buffer.alloc(12);
    ftypPayload.write('isom', 0, 'ascii');
    ftypPayload.write('isom', 8, 'ascii');
    const mvhdPayload = Buffer.alloc(100);
    mvhdPayload.writeUInt32BE(1, 12);
    mvhdPayload.writeUInt32BE(3860, 16);
    const hollow = Buffer.concat([
      isoBox('ftyp', ftypPayload),
      isoBox('moov', isoBox('mvhd', mvhdPayload)),
      isoBox('mdat', Buffer.alloc(32)),
    ]);
    const fetchMock = async () =>
      new Response(hollow, {
        status: 206,
        headers: { 'content-range': `bytes 0-${hollow.length - 1}/${hollow.length}` },
      });
    await expect(
      probeRemoteMp4Duration('https://private.example/hollow.mp4', undefined, fetchMock as typeof fetch),
    ).rejects.toThrow(/no track/);
  });

  it('reads a local MP4 duration without requiring ffprobe in the runtime image', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'aspb-video-check-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'webinar.mp4');
    const mp4 = makeStructuredMp4();
    writeFileSync(filePath, mp4);

    await expect(probeLocalMp4Duration(filePath)).resolves.toBe(3860);
  });
});
