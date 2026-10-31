(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OctopusOptions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  // Placeholder shown in secret fields when a value is already stored. Only
  // this sentinel keeps it; an empty field removes the stored override.
  // Pure ASCII so it is always a valid, storable string that cannot collide
  // with a pasted token (a real token never equals this exact sentinel).
  const SECRET_PLACEHOLDER = "__keep__";
  const DEFAULT_OPTIONS = Object.freeze({
    version: 1,
    connect: false,
    cloud_url: "",
    models: Object.freeze([]),
    max_concurrency: 4,
    request_timeout_seconds: 300,
    node_token: "",
    magpie_key: "",
    magpie_url: "",
  });
  const KEYS = Object.keys(DEFAULT_OPTIONS);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const copy = (value) => ({
    version: value.version,
    connect: value.connect,
    cloud_url: value.cloud_url,
    models: [...value.models],
    max_concurrency: value.max_concurrency,
    request_timeout_seconds: value.request_timeout_seconds,
    node_token: value.node_token,
    magpie_key: value.magpie_key,
    magpie_url: value.magpie_url,
  });

  // A control character is a code point below U+0020 or exactly U+007F.
  // Written as code, not a regex class, so editors cannot mangle the range.
  const hasControl = (value) => [...value].some((ch) => { const c = ch.codePointAt(0); return c < 0x20 || c === 0x7f; });

  function validCloudURL(value) {
    if (typeof value !== "string" || value.length > 4096 || hasControl(value) || value.includes("%")) return false;
    // Check the original path before URL's dot-segment and escape normalization.
    const match = /^wss:\/\/([^/?#\\\s]+)(\/[^?#\\\s]*)$/.exec(value);
    if (!match || match[1].includes("@")) return false;
    const path = match[2];
    if (path.length > 2048 || !path.endsWith("/node/v1/connect")) return false;
    if (!path.slice(1).split("/").every((part) => /^[A-Za-z0-9._~-]+$/.test(part) && part !== "." && part !== "..")) return false;
    try {
      const url = new URL(value);
      return url.protocol === "wss:" && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === path;
    } catch {
      return false;
    }
  }

  // Empty means "not set here" (env or a private file can still supply it); the
  // placeholder means "keep the stored secret". A real non-empty secret must
  // survive an HTTP header round-trip. The placeholder is never persisted as a
  // credential: the controller merges it back to the stored value before saving.
  function validSecret(value) {
    if (typeof value !== "string" || value.length > 4096) return false;
    if (value === "" || value === SECRET_PLACEHOLDER) return true;
    return new TextEncoder().encode(value).length <= 4096 &&
      ![...value].some((ch) => { const c = ch.codePointAt(0); return c < 0x20 || c >= 0x7f && c <= 0x9f || c > 0xff; });
  }

  // Empty defers to private configuration/default; otherwise literal-loopback HTTP
  // origin, matching config.mjs without depending on Node's net.isIP here.
  function validMagpieURL(value) {
    if (typeof value !== "string" || value.length > 4096) return false;
    if (value === "") return true;
    if (hasControl(value) || /[%\\?#@]/.test(value)) return false;
    const match = /^http:\/\/(\[[0-9a-fA-F:]+\]|[0-9.]+)(:[0-9]+)?\/?$/.exec(value);
    if (!match) return false;
    const host = match[1].startsWith("[") ? match[1].slice(1, -1) : match[1];
    if (match[2] && (!/^:[1-9][0-9]{0,4}$/.test(match[2]) || Number(match[2].slice(1)) > 65535)) return false;
    if (host.includes(":")) return host.toLowerCase() === "::1";
    const parts = host.split(".");
    return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
  }

  function magpiePort(value) {
    if (!value || !validMagpieURL(value)) return "";
    return new URL(value).port || "80";
  }

  function validPort(value) {
    return typeof value === "string" && (value === "" || /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535);
  }

  function validModels(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 1024) return false;
    const seen = new Set();
    for (const model of value) {
      if (typeof model !== "string" || !model || model.trim() !== model || hasControl(model) || new TextEncoder().encode(model).length > 512 || seen.has(model)) return false;
      seen.add(model);
    }
    return true;
  }

  // Why one draft entry fails the allowlist rule, for inline form feedback.
  // Kept in sync with validModels so a chip and a typed line agree.
  function modelError(model, existing) {
    if (typeof model !== "string" || !model) return "empty";
    if (model.trim() !== model) return "space";
    if (hasControl(model)) return "control";
    if (new TextEncoder().encode(model).length > 512) return "toolong";
    if ((existing || []).includes(model)) return "duplicate";
    return null;
  }

  // Merge a typed line into the working list. Nothing trims or splits on
  // commas: an ID is exact, so a line is one ID. Returns the next list and
  // the rejected line's reason (null when it merged).
  function addModel(models, line) {
    const list = Array.isArray(models) ? [...models] : [];
    const reason = modelError(line, list);
    if (reason) return { ok: false, reason, models: list };
    if (list.length >= 1024) return { ok: false, reason: "toomany", models: list };
    list.push(line);
    return { ok: true, reason: null, models: list };
  }

  // Remove one exact ID (a chip click). Unknown IDs leave the list untouched.
  function removeModel(models, id) {
    const list = (Array.isArray(models) ? models : []).filter((model) => model !== id);
    return { ok: list.length !== (models || []).length, models: list };
  }

  // Only an unchanged placeholder (or an omitted field) keeps a stored secret.
  // Clearing it explicitly removes the override and restores the private source.
  function mergeSecrets(stored, form) {
    const base = record(form) ? { ...form } : {};
    const storedRecord = record(stored) ? stored : {};
    for (const key of ["node_token", "magpie_key"]) {
      if (base[key] === SECRET_PLACEHOLDER || base[key] === undefined) {
        base[key] = typeof storedRecord[key] === "string" ? storedRecord[key] : "";
      }
    }
    if (base.magpie_url === undefined && typeof storedRecord.magpie_url === "string") {
      base.magpie_url = storedRecord.magpie_url;
    }
    return base;
  }

  // What the form should display: stored secrets become the placeholder so the
  // page never re-prints a real token. Empty secrets stay empty.
  function maskSecrets(stored) {
    const value = record(stored) ? { ...stored } : {};
    for (const key of ["node_token", "magpie_key"]) {
      if (typeof value[key] === "string" && value[key] !== "") value[key] = SECRET_PLACEHOLDER;
    }
    return value;
  }

  function validateOptions(input) {
    if (!record(input)) return { ok: false, errors: ["shape"] };
    const errors = [];
    if (Object.keys(input).some((key) => !KEYS.includes(key))) errors.push("unknown");
    if (input.version !== 1) errors.push("version");
    if (typeof input.connect !== "boolean") errors.push("connect");
    const disabled = input.connect === false && input.cloud_url === "" && Array.isArray(input.models) && input.models.length === 0 && input.max_concurrency === DEFAULT_OPTIONS.max_concurrency && input.request_timeout_seconds === DEFAULT_OPTIONS.request_timeout_seconds;
    if (!disabled && !validCloudURL(input.cloud_url)) errors.push("cloud_url");
    if (!disabled && !validModels(input.models)) errors.push("models");
    if (!Number.isInteger(input.max_concurrency) || input.max_concurrency < 1 || input.max_concurrency > 32) errors.push("max_concurrency");
    if (!Number.isInteger(input.request_timeout_seconds) || input.request_timeout_seconds < 1 || input.request_timeout_seconds > 3600) errors.push("request_timeout_seconds");
    if (!validSecret(input.node_token)) errors.push("node_token");
    if (!validSecret(input.magpie_key)) errors.push("magpie_key");
    if (!validMagpieURL(input.magpie_url)) errors.push("magpie_url");
    return errors.length ? { ok: false, errors } : { ok: true, value: copy(input), errors: [] };
  }

  function inspectStoredOptions(input) {
    const warnings = [];
    if (!record(input)) return { value: copy(DEFAULT_OPTIONS), configured: false, warnings: ["invalid"] };
    if (Object.keys(input).some((key) => !KEYS.includes(key))) warnings.push("unknown");
    const clean = {};
    for (const key of KEYS) clean[key] = own(input, key) ? input[key] : DEFAULT_OPTIONS[key];
    const result = validateOptions(clean);
    if (!result.ok) return { value: copy(DEFAULT_OPTIONS), configured: false, warnings: [...warnings, "invalid"] };
    return { value: result.value, configured: result.value.cloud_url !== "", warnings };
  }

  function optionsFromForm(fields, connect = false) {
    // Models may come as a textarea string (one exact ID per line) or as an
    // already-split chip list. Never trim or split on commas.
    const models = Array.isArray(fields.models) ? [...fields.models]
      : typeof fields.models === "string" && fields.models !== "" ? fields.models.split(/\r?\n/) : [];
    const integer = (value) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    if (own(fields, "magpie_port") && !validPort(fields.magpie_port)) return { ok: false, errors: ["magpie_port"] };
    const localURL = own(fields, "magpie_port")
      ? fields.magpie_port === "" ? "" : "http://127.0.0.1:" + fields.magpie_port
      : typeof fields.magpie_url === "string" ? fields.magpie_url : "";
    return validateOptions({
      version: 1,
      connect,
      cloud_url: fields.cloud_url,
      models,
      max_concurrency: integer(fields.max_concurrency),
      request_timeout_seconds: integer(fields.request_timeout_seconds),
      node_token: typeof fields.node_token === "string" ? fields.node_token : "",
      magpie_key: typeof fields.magpie_key === "string" ? fields.magpie_key : "",
      magpie_url: localURL,
    });
  }

  return Object.freeze({ DEFAULT_OPTIONS, SECRET_PLACEHOLDER, validateOptions, inspectStoredOptions, optionsFromForm, validCloudURL, validModels, validSecret, validMagpieURL, magpiePort, validPort, modelError, addModel, removeModel, mergeSecrets, maskSecrets });
});
