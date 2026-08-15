import { existsSync, readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_SLIDE_COUNT,
  VERIFIED_SLIDES,
  WEBINAR_DURATION_SECONDS,
  hasVerifiedTimeline,
  slideIndexForTime,
} from '../crisis_premium/js/slideTimeline.js';

const slidesSource = readFileSync(fileURLToPath(new URL('../crisis_premium/js/slides.js', import.meta.url)), 'utf8');

describe('verified webinar slide timeline', () => {
  it('contains one ordered, titled cue for every slide in the recording', () => {
    expect(hasVerifiedTimeline(VERIFIED_SLIDES)).toBe(true);
    expect(VERIFIED_SLIDES).toHaveLength(EXPECTED_SLIDE_COUNT);
    expect(VERIFIED_SLIDES[0].at).toBe(0);
    expect(VERIFIED_SLIDES.at(-1).at).toBeLessThan(WEBINAR_DURATION_SECONDS);
  });

  it('has a local image asset for every verified cue', () => {
    VERIFIED_SLIDES.forEach((_, index) => {
      const number = String(index + 1).padStart(2, '0');
      const asset = fileURLToPath(new URL(`../crisis_premium/assets/slides/slide-${number}.jpg`, import.meta.url));
      expect(existsSync(asset), asset).toBe(true);
    });
  });

  it('switches exactly at every cue and returns to the preceding slide before it', () => {
    VERIFIED_SLIDES.forEach((slide, index) => {
      expect(slideIndexForTime(slide.at)).toBe(index);
      expect(slideIndexForTime(slide.at + 0.01)).toBe(index);
      if (index > 0) expect(slideIndexForTime(slide.at - 0.01)).toBe(index - 1);
    });
  });

  it('handles startup, invalid time and seeking near the end deterministically', () => {
    expect(slideIndexForTime(-10)).toBe(0);
    expect(slideIndexForTime(Number.NaN)).toBe(0);
    expect(slideIndexForTime(3791.99)).toBe(46);
    expect(slideIndexForTime(3792)).toBe(47);
    expect(slideIndexForTime(WEBINAR_DURATION_SECONDS)).toBe(47);
  });

  it('rejects incomplete, duplicate and untitled timelines', () => {
    expect(hasVerifiedTimeline(VERIFIED_SLIDES.slice(0, -1))).toBe(false);
    expect(
      hasVerifiedTimeline(VERIFIED_SLIDES.map((slide, index) => (index === 1 ? { ...slide, at: 0 } : slide))),
    ).toBe(false);
    expect(
      hasVerifiedTimeline(VERIFIED_SLIDES.map((slide, index) => (index === 1 ? { ...slide, title: ' ' } : slide))),
    ).toBe(false);
  });

  it('uses the media clock for startup and both directions of seeking', () => {
    expect(slidesSource).not.toContain('buildUniformTimecodes');
    expect(slidesSource).toContain('slideIndexForTime(video.currentTime, verifiedTimeline)');
    expect(slidesSource).toContain("video.addEventListener('seeking', sync)");
    expect(slidesSource).toContain("video.addEventListener('seeked', sync)");
    expect(slidesSource).toContain('sync();\n  makeSpeakerDraggable(video)');
  });

  it('gives every displayed slide a specific accessible description', () => {
    expect(VERIFIED_SLIDES.every(slide => slide.title.trim().length > 0)).toBe(true);
    expect(slidesSource).toContain('Слайд ${idx + 1} из ${SLIDE_COUNT}.');
    expect(slidesSource).toContain('slide.dataset.slideIndex = String(idx + 1)');
  });
});
