export type VideoCheckConfig = {
  sourceKind: 'HLS' | 'MP4';
  probeSource: string;
  expectedDurationSeconds: number;
  toleranceSeconds: number;
  originToken?: string;
};

export function resolveVideoCheckConfig(options?: {
  environment?: Record<string, string | undefined>;
  cwd?: string;
}): VideoCheckConfig;

export function assertExpectedDuration(
  actualDurationSeconds: number,
  expectedDurationSeconds: number,
  toleranceSeconds: number,
): void;

export function probeHlsSource(
  source: string,
  originToken?: string,
  fetchImpl?: typeof fetch,
  depth?: number,
): Promise<number>;

export function probeRemoteMp4Duration(source: string, originToken?: string, fetchImpl?: typeof fetch): Promise<number>;

export function probeLocalMp4Duration(source: string): Promise<number>;
