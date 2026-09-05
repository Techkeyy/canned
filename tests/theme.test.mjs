import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const THEME_SOURCE = readFileSync(new URL("../web/canned-theme.js", import.meta.url), "utf8");
const THEME_CSS = readFileSync(new URL("../web/canned-theme.css", import.meta.url), "utf8");
const PRODUCT_PAGES = [
  "agent.html",
  "health-baseline.html",
  "hire.html",
  "hires.html",
  "home.html",
  "inspection.html",
  "leash.html",
  "list.html",
  "marketplace.html",
  "rebalance-baseline.html",
  "yield-baseline.html",
];

function harness({ stored = null, systemDark = false } = {}) {
  const values = new Map(stored === null ? [] : [["canned-theme", stored]]);
  const media = { matches: systemDark, listeners: [] };
  const root = { dataset: {} };
  const document = {
    documentElement: root,
    readyState: "loading",
    addEventListener(name, callback) {
      assert.equal(name, "DOMContentLoaded");
      this.readyCallback = callback;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    matchMedia: (query) => {
      assert.equal(query, "(prefers-color-scheme: dark)");
      return {
        get matches() { return media.matches; },
        addEventListener: (name, callback) => {
          assert.equal(name, "change");
          media.listeners.push(callback);
        },
      };
    },
  };
  runInNewContext(THEME_SOURCE, { window, document });
  return {
    root,
    window,
    theme: window.CannedTheme,
    setSystemDark(value) {
      media.matches = value;
      media.listeners.forEach((listener) => listener({ matches: value }));
    },
  };
}

test("first visit defaults to system and follows the operating system", () => {
  const page = harness({ systemDark: true });
  assert.equal(page.theme.getPreference(), "system");
  assert.equal(page.root.dataset.theme, "dark");
  assert.equal(page.root.dataset.themePreference, "system");

  page.setSystemDark(false);
  assert.equal(page.root.dataset.theme, "light");
  assert.equal(page.theme.getPreference(), "system");
});

test("explicit light and dark preferences override system", () => {
  const page = harness({ systemDark: true });
  page.theme.setPreference("light");
  assert.equal(page.root.dataset.theme, "light");
  page.setSystemDark(false);
  assert.equal(page.root.dataset.theme, "light");

  page.theme.setPreference("dark");
  assert.equal(page.root.dataset.theme, "dark");
  page.setSystemDark(true);
  assert.equal(page.root.dataset.theme, "dark");
});

test("explicit selection persists and reloads", () => {
  const first = harness({ systemDark: false });
  first.theme.setPreference("dark");
  assert.equal(first.window.localStorage.getItem("canned-theme"), "dark");

  const reloaded = harness({ stored: first.window.localStorage.getItem("canned-theme"), systemDark: false });
  assert.equal(reloaded.theme.getPreference(), "dark");
  assert.equal(reloaded.root.dataset.theme, "dark");
});

test("invalid stored preference safely falls back to system", () => {
  const page = harness({ stored: "sepia", systemDark: true });
  assert.equal(page.theme.getPreference(), "system");
  assert.equal(page.root.dataset.theme, "dark");
});

test("only the documented preferences are accepted", () => {
  const page = harness();
  assert.deepEqual([...page.theme.validPreferences], ["system", "light", "dark"]);
  page.theme.setPreference("invalid");
  assert.equal(page.theme.getPreference(), "system");
  assert.equal(page.window.localStorage.getItem("canned-theme"), "system");
});

test("all product pages load the early theme assets", () => {
  for (const page of PRODUCT_PAGES) {
    const html = readFileSync(new URL(`../web/${page}`, import.meta.url), "utf8");
    const cssAt = html.indexOf('href="/canned-theme.css"');
    const jsAt = html.indexOf('src="/canned-theme.js"');
    assert.ok(cssAt > -1, `${page} loads the theme stylesheet`);
    assert.ok(jsAt > -1 && jsAt < html.indexOf("</head>"), `${page} loads the theme script in head`);
  }
});

test("theme control is keyboard-labelled and does not access wallet or write APIs", () => {
  assert.ok(THEME_SOURCE.includes('aria-label="Choose appearance"'));
  assert.ok(THEME_SOURCE.includes('value="system" data-theme-option'));
  assert.ok(THEME_SOURCE.includes('value="light" data-theme-option'));
  assert.ok(THEME_SOURCE.includes('value="dark" data-theme-option'));
  assert.doesNotMatch(THEME_SOURCE, /ethereum|fetch|sendTransaction|writeContract|signMessage/i);
});

test("dark theme defines restrained readable tokens and surfaces", () => {
  assert.ok(THEME_CSS.includes('html[data-theme="dark"]'));
  for (const token of ["--paper", "--panel", "--ink", "--muted", "--line", "--accent"]) {
    assert.match(THEME_CSS, new RegExp(`${token}:`));
  }
  assert.doesNotMatch(THEME_CSS, /#000000|#00ff00|#ff00ff/i);
});
