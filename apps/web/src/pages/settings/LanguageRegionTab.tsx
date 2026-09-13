import { SUPPORTED_LOCALES } from "@projecthub/shared";
import { api, ApiError } from "../../lib/api.js";
import { setStoredLocale } from "../../lib/a11y.js";
import Select from "../../components/Select.js";
import type { SettingsTabProps } from "./types.js";

const LOCALE_LABELS: Record<string, string> = {
  en: "English (en)",
};

/**
 * Instant apply, no Save button. SUPPORTED_LOCALES currently ships with
 * only "en" (see docs/PHASES.md) — locale is persisted for real, but no
 * UI string is translated yet. A real, enabled Select with one option
 * rather than a disabled-looking control, so this reads as "more languages
 * coming soon", not broken.
 */
export default function LanguageRegionTab({ settings, onSettingsChange }: SettingsTabProps) {
  async function handleChange(locale: string) {
    if (locale === settings.locale) return;
    try {
      const res = await api.patch<{ user: typeof settings }>("/api/auth/me/preferences", { locale });
      onSettingsChange(res.user);
      setStoredLocale(res.user.locale);
    } catch (err) {
      // A locale change failing is low-stakes and there's only one option
      // today; nothing else on this tab depends on it succeeding.
      void (err instanceof ApiError ? err.message : err);
    }
  }

  return (
    <div className="ph-card ph-card-wide">
      <h1 style={{ fontSize: "1rem" }}>Language & Region</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        Select your preferred language.
      </p>
      <div className="ph-field">
        <label htmlFor="settingsLocale">Language</label>
        <Select
          id="settingsLocale"
          value={settings.locale}
          onChange={handleChange}
          options={SUPPORTED_LOCALES.map((locale) => ({ value: locale, label: LOCALE_LABELS[locale] ?? locale }))}
        />
      </div>
      <p className="ph-subtitle" style={{ margin: 0 }}>
        More languages coming soon.
      </p>
    </div>
  );
}
