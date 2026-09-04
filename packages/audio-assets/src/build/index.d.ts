export const audioAssetsPath: string;

export type ProcessAndCopyAudioAssetsOptions = {
  destRoot: string;
  logger?: (message: string) => void;
  /** Empty `destRoot` before copying. Default: true (Rollup plugin behavior). Pass false for live in-place refresh. */
  wipe?: boolean;
};

export function processAndCopyAudioAssets(options: ProcessAndCopyAudioAssetsOptions): Promise<void>;

export function processAndCopyAudioAssetsPlugin(options: { sdPlugin: string }): {
  name: string;
  generateBundle: () => Promise<void>;
};

export type PrebuildAudioAssetCacheOptions = {
  logger?: (message: string) => void;
};

export function prebuildAudioAssetCache(options?: PrebuildAudioAssetCacheOptions): Promise<void>;

export function wipeProcessedCache(): Promise<void>;

export type ProcessVoiceTreeOptions = {
  /** Directory of source clips; every `.mp3` under it, at any depth, is processed. */
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
};

export type ProcessVoiceTreeResult = {
  /** Every clip written, as POSIX paths relative to `destDir`, sorted. */
  files: string[];
  processed: number;
  cached: number;
  pipelineHash: string;
};

export function processVoiceTree(options: ProcessVoiceTreeOptions): Promise<ProcessVoiceTreeResult>;

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

export const VOICE_PACKS: readonly VoicePackDefinition[];

/** Voice ids the plugin build's audio copy step keeps inside the distributable. */
export const BUNDLED_VOICE_IDS: readonly string[];
