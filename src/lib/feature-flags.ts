export interface FeatureFlagConfig {
  features?: { skillRecorder?: boolean; browser?: boolean };
}

/** Experimental features are available only after an explicit opt-in. */
export function skillRecorderEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillRecorder === true;
}

/** Built-in browser is opt-out; the native bridge still gates availability. */
export function builtInBrowserEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.browser !== false;
}
