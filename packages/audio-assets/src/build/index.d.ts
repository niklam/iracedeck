export const audioAssetsPath: string;

export type ProcessAndCopyAudioAssetsOptions = {
  destRoot: string;
  logger?: (message: string) => void;
};

export function processAndCopyAudioAssets(options: ProcessAndCopyAudioAssetsOptions): Promise<void>;

export function processAndCopyAudioAssetsPlugin(options: { sdPlugin: string }): {
  name: string;
  generateBundle: () => Promise<void>;
};
