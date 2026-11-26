import {
  getDownloadQuality,
  getSettings,
  normalizeDownloadFormat,
  normalizeDownloadQualityPolicy,
  updateSettings,
  useSettings,
  type DownloadFormat,
  type DownloadQualityPolicy,
} from "./settings";

export interface DownloadOverrideEntry {
  quality: number | null;
  format: DownloadFormat | null;
}

export function getDownloadOverride(_key?: string): DownloadOverrideEntry {
  const s = getSettings();
  return {
    quality: getDownloadQuality(s),
    format: normalizeDownloadFormat(s.downloadFormat),
  };
}

export function setDownloadQualityOverride(_key: string, quality: number | null): void {
  updateSettings({ downloadQuality: quality ?? undefined });
}

export function setDownloadFormatOverride(_key: string, format: DownloadFormat | null): void {
  updateSettings({ downloadFormat: format ? normalizeDownloadFormat(format) : "mp4" });
}

export function clearDownloadOverrides(_key?: string): void {
  /* Persisted globally in Settings; no ephemeral overrides to clear. */
}

/**
 * Shared persisted download quality, container format, and fallback policy preferences across
 * Title, QuickDossier, DownloadsVault, Watch, and Settings.
 */
export function useDownloadPrefs(_key?: string) {
  const settings = useSettings();
  const defaultQuality = settings.preferredQuality;
  const defaultFormat = normalizeDownloadFormat(settings.downloadFormat);
  const quality = getDownloadQuality(settings);
  const format = defaultFormat;
  const policy = normalizeDownloadQualityPolicy(settings.downloadQualityPolicy);

  return {
    quality,
    format,
    policy,
    defaultQuality,
    defaultFormat,
    qualityOverridden: quality !== defaultQuality,
    formatOverridden: format !== "mp4",
    setQuality: (q: number | null) => {
      updateSettings({ downloadQuality: q ?? undefined });
    },
    setFormat: (f: DownloadFormat | null) => {
      updateSettings({ downloadFormat: f ? normalizeDownloadFormat(f) : "mp4" });
    },
    setPolicy: (p: DownloadQualityPolicy) => {
      updateSettings({ downloadQualityPolicy: normalizeDownloadQualityPolicy(p) });
    },
  };
}
