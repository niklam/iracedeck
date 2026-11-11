export declare const audioAssetsPath: string;

/**
 * How every voice clip is loudness-normalized ahead of the radio filter
 * (#1657): `VOICE_LOUDNESS_NORMALIZATION` in `src/presets.mjs`, which documents
 * each value.
 */
export type VoiceLoudnessNormalization = {
  /** The integrated loudness every clip is moved to, in LUFS. */
  targetLufs: number;
  /** The clamp on the gain, either way, in dB. */
  maxGainDb: number;
  /** The gain is rounded to this step, in dB, and printed with its decimals. */
  gainStepDb: number;
  /** A reading below this (LUFS) is taken as silence: 0 dB and a warning. */
  silenceFloorLufs: number;
  /** How a clip is measured: `loops` copies of it through `filter`. */
  measurement: { loops: number; filter: string };
};

/**
 * Everything a processed clip's bytes depend on besides the source clip
 * (#1667). Hashed as sorted-key JSON for both the processed-clip cache key and
 * the pack record's `inputs.pipeline`; a new pipeline input is one more field.
 */
export type PipelineIdentity = {
  /** The radio filter chain, `RADIO_ENGINEER_FILTER`. */
  filter: string;
  /** The loudness normalization ahead of the filter, `VOICE_LOUDNESS_NORMALIZATION` (#1657). */
  loudness: VoiceLoudnessNormalization;
  /** The ffmpeg encode arguments. */
  encodeArgs: readonly string[];
  /** The installed `ffmpeg-static` version, read from its `package.json`. */
  ffmpegStatic: string;
  /**
   * The binary `ffmpeg-static`'s `FFMPEG_BIN` override points at, present only
   * while that variable is set: the package version alone then no longer names
   * the binary that ran. Absent, the hash is the one records sealed before the
   * field existed carry.
   */
  ffmpegBinaryOverride?: string;
};

/** The identity `env` gives: `PIPELINE_IDENTITY` is this over `process.env`. A test's seam. */
export declare function pipelineIdentity(env?: NodeJS.ProcessEnv): PipelineIdentity;

export declare const PIPELINE_IDENTITY: Readonly<PipelineIdentity>;

/** The sha-256 (hex) of `identity` as sorted-key JSON — the pack record's `inputs.pipeline`. */
export declare function pipelineIdentityHash(identity?: PipelineIdentity): string;

/** The processed-clip cache directory name under `.cache/`: the first eight hex digits of `pipelineIdentityHash`. */
export declare function pipelineCacheKey(identity?: PipelineIdentity): string;

/**
 * The integrated loudness an `ebur128` summary in ffmpeg's stderr reports
 * (`-Infinity` for `-inf`); throws when there is none.
 *
 * @internal Exported for testing.
 */
export declare function parseIntegratedLoudness(stderr: string): number;

/**
 * Measure `inputPath`'s integrated loudness (LUFS) the way the pipeline does;
 * rejects on a failed run or an unreadable summary.
 *
 * @internal Exported for testing.
 */
export declare function measureLoudness(
  ffmpegPath: string,
  inputPath: string,
  normalization?: VoiceLoudnessNormalization,
): Promise<number>;

/**
 * The static gain that moves a clip measured at `measuredLufs` to the target:
 * rounded, clamped, 0 for silence; `warning` says why a clip needs attention.
 *
 * @internal Exported for testing.
 */
export declare function loudnessGain(
  measuredLufs: number,
  normalization?: VoiceLoudnessNormalization,
): { gainDb: number; warning: string | null };

/**
 * `gainDb` as the `volume=` filter reads it: the step's decimals, never `-0`.
 *
 * @internal Exported for testing.
 */
export declare function formatGainDb(gainDb: number, normalization?: VoiceLoudnessNormalization): string;

/**
 * Where a clip's loudness warning goes (#1657). Called only for a clip the run
 * re-encodes, with `Voice clip <voice-id>/<group>/<clip>.mp3: <reading and
 * decision>`. Absent, the warning goes to `logger`, prefixed `WARNING: `.
 */
export type LoudnessWarn = (message: string) => void;

export type ProcessAndCopyAudioAssetsOptions = {
  destRoot: string;
  logger?: (message: string) => void;
  warn?: LoudnessWarn;
  /** Empty `destRoot` before copying. Default: true (Rollup plugin behavior). Pass false for live in-place refresh. */
  wipe?: boolean;
  /**
   * The package tree to copy from. Default: this package. A test seam — with
   * any other root, `cacheDir` is required, so a foreign tree's clips never
   * land in the plugin's own cache.
   */
  srcRoot?: string;
  /** Processed-clip cache root. Default: the build's shared `.cache/<pipeline-hash>/`; required with a foreign `srcRoot`. */
  cacheDir?: string;
  /** Which voices under `voice/` to copy: the bundled subset (default — a plugin build) or every authored voice (the scenario harness). */
  voices?: "bundled" | "all";
};

export declare function processAndCopyAudioAssets(options: ProcessAndCopyAudioAssetsOptions): Promise<void>;

export declare function processAndCopyAudioAssetsPlugin(options: { sdPlugin: string }): {
  name: string;
  generateBundle: () => Promise<void>;
};

export type PrebuildAudioAssetCacheOptions = {
  logger?: (message: string) => void;
  warn?: LoudnessWarn;
};

export declare function prebuildAudioAssetCache(options?: PrebuildAudioAssetCacheOptions): Promise<void>;

export declare function wipeProcessedCache(): Promise<void>;

export type ProcessVoiceTreeOptions = {
  /**
   * A voice's source tree (`voice/<voice-id>/`); every `.mp3` under it, at any
   * depth, is processed, and a `callouts.json` directly under it is copied as-is.
   */
  srcDir: string;
  /** Where processed clips are written, mirroring `srcDir`. Created if missing, never wiped. */
  destDir: string;
  /**
   * Processed-clip cache for this subtree. Defaults to the build's shared
   * `.cache/<pipeline-hash>/voice/<…>` path when `srcDir` is inside this
   * package's `voice/` root — the same files the plugin build copies — and is
   * required for a source tree anywhere else.
   */
  cacheDir?: string;
  logger?: (message: string) => void;
  warn?: LoudnessWarn;
};

export type ProcessVoiceTreeResult = {
  /** Every clip written, as POSIX paths relative to `destDir`, sorted. Never the script. */
  files: string[];
  /** The voice's callout script as copied (`callouts.json`, relative to `destDir`), or `null` for a clips-only voice. */
  script: string | null;
  processed: number;
  cached: number;
  /** The cache key the run used — `pipelineCacheKey()`, the `.cache/<key>/` directory name. */
  pipelineHash: string;
};

export declare function processVoiceTree(options: ProcessVoiceTreeOptions): Promise<ProcessVoiceTreeResult>;

/** One published voice pack — see `voice-packs.mjs` for what each field means. */
export type VoicePackDefinition = {
  id: string;
  label: string;
  version: string;
  description?: string;
  author?: string;
  /** Voice ids; each has `configs/<id>.voice.json` and a `voice/<id>/` clip tree. */
  voices: readonly string[];
  minPluginVersion?: string;
  /** Whether the plugin distributable still carries this pack's clips. */
  bundled: boolean;
};

export declare const VOICE_PACKS: readonly VoicePackDefinition[];

/** Voice ids the plugin build's audio copy step keeps inside the distributable. */
export declare const BUNDLED_VOICE_IDS: readonly string[];

/** Every voice of every published pack, bundled or not. */
export declare const PUBLISHED_VOICE_IDS: readonly string[];
