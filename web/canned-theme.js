(function () {
  "use strict";

  const STORAGE_KEY = "canned-theme";
  const SYSTEM_QUERY = "(prefers-color-scheme: dark)";
  const VALID_PREFERENCES = new Set(["system", "light", "dark"]);
  const root = document.documentElement;

  function normalizePreference(value) {
    return VALID_PREFERENCES.has(value) ? value : "system";
  }

  function storage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  function readPreference() {
    const value = storage()?.getItem(STORAGE_KEY);
    return normalizePreference(value);
  }

  function mediaQuery() {
    try {
      return window.matchMedia(SYSTEM_QUERY);
    } catch {
      return null;
    }
  }

  function systemIsDark() {
    return mediaQuery()?.matches === true;
  }

  function effectiveTheme(preference) {
    const normalized = normalizePreference(preference);
    return normalized === "dark" || (normalized === "system" && systemIsDark()) ? "dark" : "light";
  }

  function apply(preference) {
    const normalized = normalizePreference(preference);
    root.dataset.theme = effectiveTheme(normalized);
    root.dataset.themePreference = normalized;
    return normalized;
  }

  function syncControl() {
    const preference = readPreference();
    document.querySelectorAll("[data-theme-option]").forEach((input) => {
      input.checked = input.value === preference;
    });
  }

  function setPreference(preference) {
    const normalized = normalizePreference(preference);
    try {
      storage()?.setItem(STORAGE_KEY, normalized);
    } catch {
      // A blocked storage area should not prevent the current page from being themed.
    }
    apply(normalized);
    syncControl();
    return normalized;
  }

  function installControl() {
    const host = document.querySelector(".topbar-inner") || document.querySelector(".topbar") || document.querySelector(".top");
    if (!host || host.querySelector("[data-theme-control]")) return;

    const control = document.createElement("details");
    control.className = "theme-control";
    control.dataset.themeControl = "";
    control.innerHTML = '<summary aria-label="Choose appearance">Appearance</summary>'
      + '<div class="theme-menu"><fieldset><legend>Appearance</legend>'
      + '<label><input type="radio" name="canned-theme" value="system" data-theme-option> System</label>'
      + '<label><input type="radio" name="canned-theme" value="light" data-theme-option> Light</label>'
      + '<label><input type="radio" name="canned-theme" value="dark" data-theme-option> Dark</label>'
      + "</fieldset></div>";
    host.append(control);
    control.querySelectorAll("[data-theme-option]").forEach((input) => {
      input.addEventListener("change", () => setPreference(input.value));
    });
    syncControl();
  }

  function watchSystemTheme() {
    const query = mediaQuery();
    if (!query) return;
    const update = () => {
      if (readPreference() === "system") apply("system");
    };
    if (typeof query.addEventListener === "function") query.addEventListener("change", update);
    else if (typeof query.addListener === "function") query.addListener(update);
  }

  apply(readPreference());
  watchSystemTheme();
  window.CannedTheme = Object.freeze({
    storageKey: STORAGE_KEY,
    validPreferences: ["system", "light", "dark"],
    getPreference: readPreference,
    getEffectiveTheme: () => effectiveTheme(readPreference()),
    setPreference,
    refresh: () => apply(readPreference()),
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installControl, { once: true });
  else installControl();
}());
