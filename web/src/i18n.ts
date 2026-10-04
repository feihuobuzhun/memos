import i18n, { BackendModule, FallbackLng, FallbackLngObjList } from "i18next";
import { orderBy } from "lodash-es";
import { initReactI18next } from "react-i18next";
import { findNearestMatchedLanguage } from "./utils/i18n";

// This instance ships Simplified Chinese and English only.
export const locales = orderBy(["en", "zh-Hans"]);

const fallbacks = {
  // Every Chinese variant falls back to Simplified Chinese; everything else
  // falls back to English through the default entry below.
  "zh-HK": ["zh-Hans", "en"],
  "zh-TW": ["zh-Hans", "en"],
  "zh-Hant": ["zh-Hans", "en"],
  zh: ["zh-Hans", "en"],
} as FallbackLngObjList;

const LazyImportPlugin: BackendModule = {
  type: "backend",
  init: function () {},
  read: function (language, _, callback) {
    const matchedLanguage = findNearestMatchedLanguage(language);
    import(`./locales/${matchedLanguage}.json`)
      .then((translationModule: Record<string, unknown>) => {
        callback(null, (translationModule.default as Record<string, unknown>) ?? translationModule);
      })
      .catch(() => {
        import("./locales/en.json")
          .then((translationModule: Record<string, unknown>) => {
            callback(null, (translationModule.default as Record<string, unknown>) ?? translationModule);
          })
          .catch((error: unknown) => {
            callback(error as Error, false);
          });
      });
  },
};

i18n
  .use(LazyImportPlugin)
  .use(initReactI18next)
  .init({
    detection: {
      order: ["navigator"],
    },
    interpolation: {
      escapeValue: false,
    },
    fallbackLng: {
      ...fallbacks,
      ...{ default: ["en"] },
    } as FallbackLng,
  });

export default i18n;
export type TLocale = (typeof locales)[number];
