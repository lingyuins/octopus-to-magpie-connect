// Browser-only test fixture. Never used or loaded by the installed page.
(function () {
  "use strict";
  const listeners = new Set();
  let stored = {};
  let failure = null;
  let theme = null;
  let lastSet = -Infinity;
  let resolveReady;
  let rejectReady;
  let helloComplete = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const calls = [];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function paintTheme() {
    document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
    document.documentElement.style.colorScheme = theme.dark ? "dark" : "light";
    document.documentElement.style.setProperty("--magpie-bg", theme.dark ? "#151820" : "#f6f8fb");
    document.documentElement.style.setProperty("--magpie-fg", theme.dark ? "#e3e8f0" : "#202631");
  }
  window.magpie = {
    ready,
    get theme() { return theme; },
    onTheme(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    options: {
      async get() {
        if (failure === "get") throw new Error("fixture load failure");
        return clone(stored);
      },
      async set(value) {
        if (Date.now() - lastSet < 1000) throw new Error("fixture rate limit");
        lastSet = Date.now();
        calls.push(clone(value));
        if (failure === "set") throw new Error("fixture save failure");
        stored = clone(value);
        return clone(stored);
      },
    },
  };
  // Test harness controls, not extra Magpie bridge calls. Hello resolves ready
  // without firing onTheme, just like the official bridge's initial handshake.
  window.octopusFixture = {
    calls,
    seed(value) { stored = clone(value); },
    fail(value) { failure = value; },
    hello(lang = "en", dark = false) {
      if (helloComplete) return;
      helloComplete = true;
      theme = { dark, lang, tokens: {} };
      paintTheme();
      resolveReady(theme);
    },
    rejectReady() {
      if (helloComplete) return;
      helloComplete = true;
      rejectReady(new Error("fixture handshake failure"));
    },
    theme(lang, dark = false) {
      theme = { dark, lang, tokens: {} };
      paintTheme();
      for (const fn of listeners) fn(theme);
    },
  };
  const params = new URLSearchParams(window.location ? window.location.search : "");
  const config = window.octopusFixtureConfig || {};
  if (!config.manualHello && params.get("hello") !== "manual") {
    const hello = () => window.octopusFixture.hello(config.lang || params.get("lang") || "en", Boolean(config.dark) || params.get("dark") === "1");
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hello, { once: true });
    else Promise.resolve().then(hello);
  }
})();
