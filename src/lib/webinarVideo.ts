import { env } from './env.js';
import { WEBINAR_VIDEO_PATH } from './webinarTimeline.js';

export type WebinarVideoConfig = {
  provider: typeof env.WEBINAR_VIDEO_PROVIDER;
  src: string | null;
  hlsSrc: string | null;
  poster: string | null;
  fallbackAllowed: boolean;
};

export function getWebinarVideoConfig(session?: {
  videoUrl?: string | null;
  posterUrl?: string | null;
}): WebinarVideoConfig {
  const fallbackAllowed = env.NODE_ENV !== 'production';
  const hlsSrc = env.WEBINAR_VIDEO_HLS_URL ?? null;
  const configuredMp4 = env.WEBINAR_VIDEO_URL ?? session?.videoUrl ?? null;
  const src = hlsSrc ? configuredMp4 : (configuredMp4 ?? (fallbackAllowed ? WEBINAR_VIDEO_PATH : null));

  return {
    provider: env.WEBINAR_VIDEO_PROVIDER,
    src: fallbackAllowed ? src : configuredMp4,
    hlsSrc,
    poster: env.WEBINAR_POSTER_URL ?? session?.posterUrl ?? null,
    fallbackAllowed,
  };
}

export function getVideoCspOrigins() {
  const publicOrigin = new URL(env.PUBLIC_SITE_URL).origin;
  const urls = [env.WEBINAR_VIDEO_URL, env.WEBINAR_VIDEO_HLS_URL, env.WEBINAR_POSTER_URL].filter(Boolean);
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
