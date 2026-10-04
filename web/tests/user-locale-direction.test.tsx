import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUserLocale } from "@/hooks/useUserLocale";
import i18n from "@/i18n";

// This build only ships "en" and "zh-Hans" (both LTR); zh-Hans is used here as
// the non-default locale to verify the hook applies a user's locale setting.
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ userGeneralSetting: { locale: "zh-Hans" } }),
}));

const originalLanguage = i18n.language;
const originalLangAttribute = document.documentElement.getAttribute("lang");
const originalDirAttribute = document.documentElement.getAttribute("dir");

describe("useUserLocale", () => {
  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem("memos-locale", "en");
    document.documentElement.lang = "en";
    document.documentElement.dir = "ltr";
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    localStorage.clear();
    if (originalLangAttribute === null) document.documentElement.removeAttribute("lang");
    else document.documentElement.lang = originalLangAttribute;
    if (originalDirAttribute === null) document.documentElement.removeAttribute("dir");
    else document.documentElement.dir = originalDirAttribute;
    await i18n.changeLanguage(originalLanguage);
  });

  it("applies the user's locale setting to the document", async () => {
    const { result } = renderHook(() => useUserLocale());

    await waitFor(() => expect(document.documentElement).toHaveAttribute("lang", "zh-Hans"));
    expect(result.current).toBe("ltr");
    expect(document.documentElement).toHaveAttribute("dir", "ltr");
  });
});
