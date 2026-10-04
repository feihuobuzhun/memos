import { describe, expect, it } from "vitest";
import { locales } from "@/i18n";
import enTranslation from "@/locales/en.json";
import zhHansTranslation from "@/locales/zh-Hans.json";
import { getLocaleSearchLabels, localeMatchesSearch, normalizeLocaleSearchText } from "@/utils/i18n";

const flattenTranslationKeys = (value: unknown, prefix = ""): string[] => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) => flattenTranslationKeys(child, prefix ? `${prefix}.${key}` : key));
  }

  return [prefix];
};

describe("locale search helpers", () => {
  it("normalizes case and diacritics for locale search", () => {
    expect(normalizeLocaleSearchText("Português")).toBe("portugues");
  });

  it("includes locale code, native name, and English name", () => {
    const labels = getLocaleSearchLabels("zh-Hans", "en");

    expect(labels).toContain("zh-Hans");
    expect(labels).toContain("简体中文");
    expect(labels).toContain("Simplified Chinese");
  });

  it("matches by code, native display name, English display name, and accent-free text", () => {
    expect(localeMatchesSearch("zh-Hans", "zh", "en")).toBe(true);
    expect(localeMatchesSearch("zh-Hans", "中文", "en")).toBe(true);
    expect(localeMatchesSearch("en", "english", "en")).toBe(true);
    expect(localeMatchesSearch("en", "romanian", "en")).toBe(false);
  });

  it("ships exactly Simplified Chinese and English", () => {
    expect([...locales].sort()).toEqual(["en", "zh-Hans"]);
  });

  it("keeps the Simplified Chinese catalog aligned with the English one", () => {
    expect(flattenTranslationKeys(zhHansTranslation).sort()).toEqual(flattenTranslationKeys(enTranslation).sort());
  });
});
