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
