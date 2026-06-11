import { env } from './env.js';
import { WEBINAR_BROADCAST_POSTER_URL, WEBINAR_BROADCAST_VIDEO_URL } from './webinarTimeline.js';

export type WebinarVideoConfig = {
  provider: typeof env.WEBINAR_VIDEO_PROVIDER;
  src: string | null;
  hlsSrc: string | null;
  poster: string | null;
  fallbackAllowed: boolean;
  localFallbackAllowed: boolean;
  externalMp4Allowed: boolean;
};

export function getWebinarVideoConfig(session?: {
  videoUrl?: string | null;
  posterUrl?: string | null;
}): WebinarVideoConfig {
  const localFallbackAllowed = env.NODE_ENV !== 'production';
  const hlsSrc = env.WEBINAR_VIDEO_HLS_URL ?? null;
  const configuredMp4 = env.WEBINAR_VIDEO_URL ?? session?.videoUrl ?? WEBINAR_BROADCAST_VIDEO_URL;
  const src = configuredMp4 ?? null;

  return {
    provider: env.WEBINAR_VIDEO_PROVIDER,
    src,
    hlsSrc,
    poster: env.WEBINAR_POSTER_URL ?? session?.posterUrl ?? WEBINAR_BROADCAST_POSTER_URL,
    fallbackAllowed: localFallbackAllowed,
    localFallbackAllowed,
    externalMp4Allowed: Boolean(configuredMp4),
  };
}

export function getVideoCspOrigins() {
  const publicOrigin = new URL(env.PUBLIC_SITE_URL).origin;
  const urls = [
    env.WEBINAR_VIDEO_URL,
    env.WEBINAR_VIDEO_HLS_URL,
    env.WEBINAR_POSTER_URL,
    WEBINAR_BROADCAST_VIDEO_URL,
    WEBINAR_BROADCAST_POSTER_URL,
  ].filter(Boolean);
  return [
    ...new Set(
      urls.flatMap(value => {
        try {
          const url = new URL(value as string);
          return url.origin === publicOrigin ? [] : [url.origin];
        } catch {
          return [];
        }
      }),
    ),
  ];
}
