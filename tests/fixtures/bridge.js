// Browser-only test fixture. Never used or loaded by the installed page.
(function () {
  "use strict";
  const listeners = new Set();
  let stored = {};
  let failure = null;
  let theme = { dark: false, lang: "en", tokens: {} };
  let lastSet = -Infinity;
  const calls = [];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function paintTheme() {
    document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
    document.documentElement.style.colorScheme = theme.dark ? "dark" : "light";
    document.documentElement.style.setProperty("--magpie-bg", theme.dark ? "#151820" : "#f6f8fb");
    document.documentElement.style.setProperty("--magpie-fg", theme.dark ? "#e3e8f0" : "#202631");
  }
  window.magpie = {
    ready: Promise.resolve(theme),
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
  let fixtureModels = [];
  let fixtureModelsError = null;
  window.fetch = async (url, options) => {
    if (fixtureModelsError === "auth") return { ok: false, status: 401, json: async () => ({}) };
    if (fixtureModelsError) throw fixtureModelsError;
    if (typeof url !== "string" || !url.startsWith("http://127.0.0.1:")) throw new Error("fixture fetch only allows loopback");
    return { ok: true, status: 200, json: async () => ({ object: "list", data: fixtureModels.map((id) => ({ id, object: "model" })) }) };
  };
  // Test harness controls, not extra Magpie bridge calls.
  window.octopusFixture = {
    calls,
    seed(value) { stored = clone(value); },
    fail(value) { failure = value; },
    setModels(list) { fixtureModels = [...list]; fixtureModelsError = null; },
    failModels(error) { fixtureModelsError = error; },
    theme(lang, dark = false) {
      theme = { dark, lang, tokens: {} };
      paintTheme();
      for (const fn of listeners) fn(theme);
    },
  };
  paintTheme();
})();
