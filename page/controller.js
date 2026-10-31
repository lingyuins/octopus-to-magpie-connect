(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory(require("./options.js"));
  else root.OctopusController = factory(root.OctopusOptions);
})(typeof globalThis !== "undefined" ? globalThis : this, function (options) {
  "use strict";
  function createController({ bridge, onChange = function () {}, now = () => Date.now() }) {
    let state = { loaded: false, busy: false, saved: null, pending: null, warnings: [], errors: [], message: "loading", draft: [], draftError: null, importResult: null, needsRestart: false, setupVisible: false, savedAt: null };
    let lastSet = -Infinity;
    const snapshot = () => JSON.parse(JSON.stringify(state));
    const emit = () => onChange(snapshot());
    const setMessage = (message) => { state.message = message; emit(); };

    async function load() {
      if (state.busy) return false;
      state.busy = true;
      state.loaded = false;
      state.saved = null;
      state.pending = null;
      state.warnings = [];
      state.errors = [];
      state.draft = [];
      state.draftError = null;
      state.importResult = null;
      state.message = "loading";
      state.needsRestart = false;
      state.setupVisible = false;
      state.savedAt = null;
      emit();
      try {
        await bridge.ready;
        const inspected = options.inspectStoredOptions(await bridge.options.get());
        state.saved = inspected.value;
        state.warnings = inspected.warnings;
        state.draft = [...inspected.value.models];
        state.loaded = true;
        state.message = "loaded";
        return true;
      } catch {
        state.message = "loadError";
        return false;
      } finally {
        state.busy = false;
        emit();
      }
    }

    // Chip interactions edit the working draft only. They never write; the
    // change reaches Magpie only through a confirmed save/connect below.
    function addModel(line) {
      if (!state.loaded || state.busy || state.pending) return false;
      const result = options.addModel(state.draft, line);
      state.draft = result.models;
      state.draftError = result.reason;
      emit();
      return result.ok;
    }

    function importModels(input) {
      if (!state.loaded || state.busy || state.pending) return false;
      const result = options.importModels(state.draft, input);
      if (result.ok) state.draft = result.models;
      state.importResult = { ok: result.ok, reason: result.reason, added: result.added, skipped: result.skipped };
      if (result.ok) state.draftError = null;
      emit();
      return result.ok;
    }

    function removeModel(id) {
      if (!state.loaded || state.busy || state.pending) return false;
      const result = options.removeModel(state.draft, id);
      state.draft = result.models;
      state.draftError = null;
      emit();
      return result.ok;
    }

    function clearDraftError() {
      if (state.draftError === null) return;
      state.draftError = null;
      emit();
    }

    function dismissSetup() {
      if (!state.setupVisible) return false;
      state.setupVisible = false;
      emit();
      return true;
    }

    function request(action, fields) {
      if (!state.loaded || state.busy || state.pending) return false;
      if (!["save", "connect", "disconnect"].includes(action)) return false;
      let result;
      if (action === "disconnect") {
        // The stored secrets ride along untouched; nothing on the form is read.
        result = options.validateOptions({ ...state.saved, connect: false });
      } else {
        // The chip draft is the source of truth for the model allowlist, and a
        // secret field left at its placeholder keeps the stored secret.
        result = options.optionsFromForm({ ...options.mergeSecrets(state.saved, fields), models: state.draft }, action === "connect" || state.saved.connect);
      }
      if (!result.ok || (action === "connect" && result.value.cloud_url === "")) {
        state.errors = result.ok ? ["cloud_url", "models"] : result.errors;
        setMessage("invalidForm");
        return false;
      }
      state.errors = [];
      state.pending = { action, value: result.value };
      setMessage("confirm");
      return true;
    }

    function cancel() {
      if (state.busy || !state.pending) return false;
      state.pending = null;
      setMessage("cancelled");
      return true;
    }

    async function confirm() {
      if (state.busy || !state.pending) return false;
      if (now() - lastSet < 1000) { setMessage("rateLimited"); return false; }
      const pending = state.pending;
      state.busy = true;
      state.message = "saving";
      lastSet = now();
      emit();
      try {
        const saved = options.validateOptions(await bridge.options.set(pending.value));
        if (!saved.ok || JSON.stringify(saved.value) !== JSON.stringify(pending.value)) {
          state.message = "saveUnverified";
          state.pending = null;
          state.saved = null;
          state.loaded = false;
          return false;
        }
        state.saved = saved.value;
        state.warnings = [];
        state.draft = [...saved.value.models];
        state.draftError = null;
        state.importResult = null;
        state.pending = null;
        state.needsRestart = pending.action !== "disconnect";
        state.setupVisible = state.needsRestart;
        state.savedAt = now();
        state.message = state.needsRestart ? "savedRestart" : "savedDisconnected";
        return true;
      } catch {
        state.message = "saveError";
        state.pending = null;
        state.saved = null;
        state.loaded = false;
        return false;
      } finally {
        state.busy = false;
        emit();
      }
    }

    return Object.freeze({ load, request, cancel, confirm, addModel, importModels, removeModel, clearDraftError, dismissSetup, getState: snapshot });
  }
  return Object.freeze({ createController });
});
