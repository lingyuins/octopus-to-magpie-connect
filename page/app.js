(function () {
  "use strict";
  // Keep in sync with package.json; identifies this connector to the magpie
  // gateway (User-Agent is a forbidden header in browsers, so the page uses
  // X-Magpie-Agent for loopback fetches).
  const VERSION = "0.1.0";
  const messages = {
    en: {
      statusTitle: "Connection preference",
      statusHelp: "Check actual state on the cloud Octopus Nodes page.",
      badgeOn: "Connect requested", badgeOff: "Not requested",
      settingsTitle: "Connection preferences",
      cloudLabel: "Cloud WSS URL",
      cloudHelp: "Use wss://, with an optional deployment prefix and /node/v1/connect. No credentials, query, fragment, encoded paths or dot segments.",
      modelsLabel: "Allowed models",
      modelPlaceholder: "provider/exact-model-id",
      addModel: "Add",
      modelsEmpty: "No models yet. Add at least one exact model ID below before connecting.",
      modelsHelp: "Exact, case-sensitive IDs, one per chip. Click a chip to remove it. Wildcards have no special meaning; commas are literal.",
      fetchModels: "Fetch models",
      fetchingModels: "Fetching models…",
      fetchModelsNeedKey: "Enter the Magpie API key first.",
      fetchModelsNeedValidPort: "Enter a valid Magpie port number first.",
      fetchModelsAuth: "Magpie rejected the API key. Check the key and port.",
      fetchModelsFailed: "Could not fetch models. Check that Magpie is running on this port.",
      fetchedModels: "Added {count} model(s) from the Magpie gateway.",
      removeModel: "Remove {id}",
      concurrencyLabel: "Maximum concurrency (1–32)",
      timeoutLabel: "Request timeout in seconds (1–3600)",
      credentialsHelp: "Credentials are saved in plain text in plugins.json on this machine. Leave empty to use the corresponding environment variable.",
      nodeTokenLabel: "Node token",
      magpieKeyLabel: "Magpie API key",
      magpieURLLabel: "Magpie port on this machine",
      magpieURLHelp: "Enter the Magpie port number; leave empty for the default 3425.",
      setupTitle: "Complete setup, then restart Magpie",
      setupClose: "Got it",
      setupSteps: ["Fill in the cloud URL, allowed models, node token, Magpie API key and local port.", "Click Request connection and confirm the save.", "Fully quit and restart Magpie. Refreshing this page is not enough.", "In Octopus → Local nodes, check the node and click Test connection."],
      restartTitle: "Restart Magpie to apply this configuration",
      restartHelp: "Fully quit and restart Magpie; refreshing the plugin page is not enough. After restarting, check Octopus → Local nodes and click Test connection. If the node remains offline, let Magpie load its plugins through a normal plugin-using operation.",
      save: "Save preferences", connect: "Request connection", disconnect: "Request disconnection", retry: "Retry loading",
      confirmTitle: "Confirm this change", confirmButton: "Confirm", cancel: "Cancel",
      troubleTitle: "Not connecting? Check these",
      troubleSteps: [
        "Supply the node token and Magpie API key on this page, or set their environment variables before starting Magpie.",
        "After saving, fully quit and restart Magpie; the Bun host may still wait for a normal plugin-using operation.",
        "Check the actual state and run Test connection on the cloud Local nodes page. Check the local port and model allowlist if that test fails.",
      ],
      loading: "Loading plugin options…", loaded: "Options loaded. No changes have been saved by this page yet.",
      loadError: "Could not load options. Nothing was saved. Retry inside Magpie.",
      missingBridge: "The official Magpie bridge is unavailable. Open this page as a plugin inside Magpie.",
      saving: "Saving the requested preference…",
      savedRestart: "Configuration saved. Please fully quit and restart Magpie. Refreshing the plugin page is not enough. After restarting, check Octopus → Local nodes and click Test connection.",
      savedDisconnected: "Disconnection requested. The running connector stops when it observes the change. Check the cloud Local nodes page to confirm; no restart is needed to request disconnection.",
      saveError: "The save could not be confirmed. Saved state may have changed; reload the page before retrying.",
      saveUnverified: "Magpie returned unexpected options. The save is unverified; reload the page before retrying.",
      rateLimited: "Wait at least one second between saves, then confirm again.",
      invalidForm: "Please correct the fields below. Disconnection can still use the last valid saved configuration.",
      confirm: "Review the confirmation below. Nothing has been saved yet.", cancelled: "Change cancelled. Nothing was saved.",
      unknown: "Unrecognized option fields were ignored and are not displayed. Saving replaces options using only the nine known fields, credentials included.",
      invalid: "Stored options are invalid. They are not displayed; the form uses safe disconnected defaults. Nothing was automatically saved.",
      desiredOn: "Connect",
      desiredOff: "Do not connect",
      noState: "Saved request: unknown (options are not loaded).",
      invalidState: "Stored request is invalid. Disconnected defaults shown below have not been saved.",
      modelCount: "{count} allowed",
      model_empty: "Enter a model ID.",
      model_space: "No surrounding spaces allowed in a model ID.",
      model_control: "Control characters are not allowed in a model ID.",
      model_toolong: "A model ID is at most 512 UTF-8 bytes.",
      model_duplicate: "That model ID is already in the list.",
      model_toomany: "At most 1024 model IDs.",
      confirmSave: "Save these preferences, credentials included, in plain text in plugins.json? The saved connection request is preserved. Magpie may reload its plugin host and fail in-flight requests.",
      confirmConnect: "Save connect=true with the displayed preferences and credentials (plain text in plugins.json)? The in-host connector may expose the allowed models to cloud requests. Host reload may fail in-flight requests; fully quit and restart Magpie after saving, then test the node in Octopus.",
      confirmDisconnect: "Save connect=false using the last valid saved configuration, ignoring current form edits? A watching Connector is asked to disconnect. Verify the actual state on the cloud Nodes page.",
      error_cloud_url: "Cloud URL must be a safe wss:// URL ending in /node/v1/connect. Empty URL and models are allowed only with connect=false, concurrency 4 and timeout 300.",
      error_models: "Enter 1–1024 unique exact model IDs as chips, each at most 512 UTF-8 bytes, without control characters or surrounding spaces.",
      error_max_concurrency: "Maximum concurrency must be an integer from 1 to 32.",
      error_request_timeout_seconds: "Request timeout must be an integer from 1 to 3600 seconds.",
      error_node_token: "Node token must be empty or a single-line Latin-1 string of at most 4096 bytes.",
      error_magpie_key: "Magpie API key must be empty or a single-line Latin-1 string of at most 4096 bytes.",
      error_magpie_url: "The stored local address is invalid. Enter only the Magpie port, such as 3425.",
      error_magpie_port: "Enter a whole port number from 1 to 65535, or leave empty for private configuration/default 3425.",
      error_generic: "The configuration has an unsupported shape or version.",
    },
    zh: {
      statusTitle: "连接期望",
      statusHelp: "实际状态请到云端 Octopus 节点页查看。",
      badgeOn: "已请求连接", badgeOff: "未请求连接",
      settingsTitle: "连接偏好",
      cloudLabel: "云端 WSS 地址",
      cloudHelp: "使用 wss://，可带部署前缀，路径以 /node/v1/connect 结尾。禁止凭据、查询参数、片段、编码路径和点路径段。",
      modelsLabel: "允许的模型",
      modelPlaceholder: "provider/exact-model-id",
      addModel: "添加",
      modelsEmpty: "还没有模型。连接前请在下方至少添加一个精确的模型 ID。",
      modelsHelp: "精确且区分大小写的 ID，每个一个标签。点击标签即可移除。通配符没有特殊含义，逗号按字面处理。",
      fetchModels: "获取模型",
      fetchingModels: "正在获取模型…",
      fetchModelsNeedKey: "请先填写 Magpie API 密钥。",
      fetchModelsNeedValidPort: "请先填写有效的 Magpie 端口号。",
      fetchModelsAuth: "Magpie 拒绝了 API 密钥，请检查密钥和端口。",
      fetchModelsFailed: "无法获取模型，请确认 Magpie 已在该端口运行。",
      fetchedModels: "已从 Magpie 网关添加 {count} 个模型。",
      removeModel: "移除 {id}",
      concurrencyLabel: "最大并发数（1–32）",
      timeoutLabel: "请求超时秒数（1–3600）",
      credentialsHelp: "凭据以明文保存在本机 plugins.json 中。留空则使用对应环境变量。",
      nodeTokenLabel: "节点令牌",
      magpieKeyLabel: "Magpie API 密钥",
      magpieURLLabel: "本机 Magpie 端口",
      magpieURLHelp: "填写 Magpie 端口号，不填写默认 3425。",
      setupTitle: "填写完毕后，请重启 Magpie",
      setupClose: "知道了",
      setupSteps: ["填写云端地址、允许的模型、节点令牌、Magpie API 密钥与本机端口。", "点击“请求连接”并确认保存。", "完全退出并重新启动 Magpie；仅刷新插件页面不够。", "到 Octopus → 本地节点查看状态，并点击“测试连接”。"],
      restartTitle: "请重启 Magpie，使配置生效",
      restartHelp: "请完全退出并重新启动 Magpie，仅刷新插件页面不够。重启后，请到 Octopus 的“本地节点”页面查看状态并点击“测试连接”。若仍离线，请执行一次正常的、会加载插件的 Magpie 操作。",
      save: "保存偏好", connect: "请求连接", disconnect: "请求断开", retry: "重新加载",
      confirmTitle: "确认此项变更", confirmButton: "确认", cancel: "取消",
      troubleTitle: "连不上？请逐项检查",
      troubleSteps: [
        "在页面填写节点令牌与 Magpie API 密钥，或在启动 Magpie 前设置对应环境变量。",
        "保存后完全退出并重启 Magpie；Bun 宿主仍可能需要一次正常的插件调用才会启动。",
        "在云端本地节点页查看真实状态并点击“测试连接”；失败时检查本机端口、密钥和模型允许列表。",
      ],
      loading: "正在加载插件选项…", loaded: "选项已加载；此页面尚未保存任何变更。",
      loadError: "无法加载选项，未保存任何内容。请在 Magpie 中重试。",
      missingBridge: "Magpie 官方桥接不可用，请在 Magpie 中以插件方式打开此页面。",
      saving: "正在保存期望设置…",
      savedRestart: "配置已保存，请完全退出并重新启动 Magpie。仅刷新插件页面不够。重启后，请到 Octopus 的“本地节点”页面查看状态并点击“测试连接”。",
      savedDisconnected: "断开请求已保存；运行中的连接器观察到变更后会停止。请到云端本地节点页确认，无需先重启才能请求断开。",
      saveError: "无法确认保存结果，实际选项可能已变更；请重新加载页面后再试。",
      saveUnverified: "Magpie 返回了非预期选项，无法核实保存结果；请重新加载页面后再试。",
      rateLimited: "两次保存至少间隔一秒，请稍候再次确认。",
      invalidForm: "请修正以下字段。断开操作仍可使用上次合法的已保存配置。",
      confirm: "请查看下方确认说明，目前尚未保存。", cancelled: "已取消变更，未保存任何内容。",
      unknown: "已忽略且不显示未知选项字段。保存时仅写入九个已知字段（含凭据）。",
      invalid: "已存选项无效，不予回显；表单采用安全的未连接默认值，未自动保存。",
      desiredOn: "连接",
      desiredOff: "不连接",
      noState: "已存期望：未知（尚未加载选项）。",
      invalidState: "已存期望无效。下方仅显示未连接默认值，尚未保存。",
      modelCount: "已允许 {count} 个",
      model_empty: "请输入模型 ID。",
      model_space: "模型 ID 不允许首尾空格。",
      model_control: "模型 ID 不允许控制字符。",
      model_toolong: "模型 ID 最长 512 个 UTF-8 字节。",
      model_duplicate: "该模型 ID 已在列表中。",
      model_toomany: "最多 1024 个模型 ID。",
      confirmSave: "确认保存这些偏好（含凭据，明文写入 plugins.json）？将保留已存连接期望；Magpie 可能重载插件宿主并导致在途请求失败。",
      confirmConnect: "确认以当前偏好与凭据（明文写入 plugins.json）保存 connect=true？宿主内连接器可能连接云端并允许云端请求列出的模型。重载可能导致在途请求失败。保存后请完全退出并重启 Magpie，再到 Octopus 测试节点连接。",
      confirmDisconnect: "确认忽略当前表单编辑，使用上次合法的已保存配置写入 connect=false？这会请求正在监听的 Connector 断开，请到云端节点页确认实际状态。",
      error_cloud_url: "云端地址必须是以 /node/v1/connect 结尾的安全 wss:// 地址。仅在 connect=false、并发数 4、超时 300 时允许地址和模型列表同时为空。",
      error_models: "请以标签形式输入 1–1024 个不重复的精确模型 ID，每项不超过 512 个 UTF-8 字节，不得有控制字符或首尾空格。",
      error_max_concurrency: "最大并发数必须是 1–32 的整数。",
      error_request_timeout_seconds: "请求超时必须是 1–3600 秒的整数。",
      error_node_token: "节点令牌必须为空，或不超过 4096 字节的单行 Latin-1 字符串。",
      error_magpie_key: "Magpie API 密钥必须为空，或不超过 4096 字节的单行 Latin-1 字符串。",
      error_magpie_url: "已存本地地址无效，请只填写 Magpie 的端口号，例如 3425。",
      error_magpie_port: "端口必须是 1–65535 的整数；也可留空，使用私有配置或默认端口 3425。",
      error_generic: "配置结构或版本不受支持。",
    },
  };
  const byId = (id) => document.getElementById(id);
  let language = "en";
  let current = null;
  let paintedSaved = "";
  const fieldIDs = { cloud_url: "cloud-url", models: "model-input", max_concurrency: "concurrency", request_timeout_seconds: "timeout", node_token: "node-token", magpie_key: "magpie-key", magpie_url: "magpie-port", magpie_port: "magpie-port" };
  const text = (key) => messages[language][key] || messages[language].error_generic;
  const fill = (key, params) => Object.entries(params || {}).reduce((s, [k, v]) => s.split("{" + k + "}").join(String(v)), text(key));

  function paintChips(state) {
    const wrap = byId("chips");
    wrap.replaceChildren();
    for (const id of state.draft) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.setAttribute("role", "listitem");
      chip.title = fill("removeModel", { id });
      chip.setAttribute("aria-label", fill("removeModel", { id }));
      const label = document.createElement("span");
      label.textContent = id; // textContent only: model IDs are never HTML.
      const cross = document.createElement("span");
      cross.className = "chip-x";
      cross.textContent = "×";
      cross.setAttribute("aria-hidden", "true");
      chip.append(label, cross);
      chip.addEventListener("click", function () { controller.removeModel(id); });
      chip.disabled = state.busy || !state.loaded || Boolean(state.pending);
      wrap.append(chip);
    }
    byId("chips-empty").hidden = state.draft.length !== 0;
    byId("models-label").textContent = state.draft.length
      ? text("modelsLabel") + " · " + fill("modelCount", { count: state.draft.length })
      : text("modelsLabel");
    const err = byId("model-error");
    err.hidden = !state.draftError;
    err.textContent = state.draftError ? text("model_" + state.draftError) : "";
  }

  function paint(state) {
    current = state;
    const locked = state.busy || !state.loaded || Boolean(state.pending);
    byId("fields").disabled = locked;
    byId("models-fieldset").disabled = locked;
    for (const id of ["save", "connect", "disconnect"]) byId(id).disabled = locked;
    byId("retry").hidden = state.loaded || state.busy;
    byId("confirm").disabled = state.busy;
    byId("cancel").disabled = state.busy;
    byId("message").textContent = text(state.message);

    const key = !state.saved ? "noState" : state.warnings.includes("invalid") ? "invalidState" : state.saved.connect ? "desiredOn" : "desiredOff";
    byId("saved-state").textContent = text(key);
    const on = Boolean(state.saved && state.saved.connect && !state.warnings.includes("invalid"));
    byId("state-badge").dataset.state = on ? "on" : "off";
    byId("state-badge").textContent = text(on ? "badgeOn" : "badgeOff");
    byId("state-dot").dataset.state = on ? "on" : "off";
    const when = byId("saved-when");
    when.hidden = state.savedAt === null;
    when.textContent = state.savedAt === null ? "" : new Date(state.savedAt).toLocaleString();
    byId("restart-result").hidden = !state.needsRestart;
    byId("setup-card").hidden = !state.setupVisible;
    for (const id of new Set(Object.values(fieldIDs))) byId(id).setAttribute("aria-invalid", "false");
    for (const field of state.errors) if (fieldIDs[field]) byId(fieldIDs[field]).setAttribute("aria-invalid", "true");

    byId("warning").hidden = state.warnings.length === 0;
    byId("warning").textContent = state.warnings.map(text).join(" ");
    byId("errors").replaceChildren();
    byId("errors").hidden = state.errors.length === 0;
    for (const error of state.errors) {
      const item = document.createElement("li");
      item.textContent = text("error_" + error);
      byId("errors").append(item);
    }
    byId("confirmation").hidden = !state.pending;
    if (state.pending) byId("confirm-detail").textContent = text({ save: "confirmSave", connect: "confirmConnect", disconnect: "confirmDisconnect" }[state.pending.action]);

    const serialized = JSON.stringify(state.saved);
    if (!state.saved) paintedSaved = "";
    if (state.saved && paintedSaved !== serialized) {
      const masked = window.OctopusOptions.maskSecrets(state.saved);
      byId("cloud-url").value = masked.cloud_url;
      byId("concurrency").value = String(masked.max_concurrency);
      byId("timeout").value = String(masked.request_timeout_seconds);
      byId("node-token").value = masked.node_token;
      byId("magpie-key").value = masked.magpie_key;
      byId("magpie-port").value = window.OctopusOptions.magpiePort(masked.magpie_url);
      paintedSaved = serialized;
    }
    paintChips(state);
  }

  function applyTheme(theme) {
    language = /^zh(?:[-_]|$)/i.test(theme && theme.lang || "") ? "zh" : "en";
    document.documentElement.lang = language === "zh" ? "zh-Hans" : "en";
    for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = text(element.dataset.i18n);
    for (const element of document.querySelectorAll("[data-i18n-ph]")) element.placeholder = text(element.dataset.i18nPh);
    for (const element of document.querySelectorAll("[data-i18n-title]")) element.title = text(element.dataset.i18nTitle);
    for (const element of document.querySelectorAll("[data-i18n-list]")) {
      const items = text(element.dataset.i18nList);
      if (Array.isArray(items)) {
        element.replaceChildren();
        for (const line of items) {
          const li = document.createElement("li");
          li.textContent = line;
          element.append(li);
        }
      }
    }
    if (current) paint(current);
  }

  async function fetchModels() {
    const key = byId("magpie-key").value.trim();
    const status = byId("model-fetch-status");
    status.hidden = false;
    if (!key) {
      status.textContent = text("fetchModelsNeedKey");
      byId("magpie-key").focus();
      return;
    }
    const port = byId("magpie-port").value.trim() || "3425";
    if (!window.OctopusOptions.validPort(port)) {
      status.textContent = text("fetchModelsNeedValidPort");
      byId("magpie-port").focus();
      return;
    }
    const button = byId("model-fetch");
    button.disabled = true;
    status.textContent = text("fetchingModels");
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/v1/models", { headers: { authorization: "Bearer " + key, "x-magpie-agent": "octopus-ly-connector:v" + VERSION } });
      if (response.status === 401 || response.status === 403) {
        status.textContent = text("fetchModelsAuth");
        return;
      }
      if (!response.ok) throw new Error("HTTP " + response.status);
      const body = await response.json();
      const ids = Array.isArray(body && body.data) ? body.data.map((entry) => entry && entry.id).filter((id) => typeof id === "string" && id) : [];
      let added = 0;
      for (const id of ids) if (controller.addModel(id)) added += 1;
      status.textContent = fill("fetchedModels", { count: added });
    } catch {
      status.textContent = text("fetchModelsFailed");
    } finally {
      button.disabled = false;
    }
  }

  function updateFetchButton() {
    const locked = current ? current.busy || !current.loaded || Boolean(current.pending) : true;
    byId("model-fetch").disabled = locked || byId("magpie-key").value.trim() === "";
  }

  async function fetchModels() {
    const key = byId("magpie-key").value.trim();
    const status = byId("model-fetch-status");
    status.hidden = false;
    if (!key) {
      status.textContent = text("fetchModelsNeedKey");
      byId("magpie-key").focus();
      return;
    }
    const port = byId("magpie-port").value.trim() || "3425";
    if (!window.OctopusOptions.validPort(port)) {
      status.textContent = text("fetchModelsNeedValidPort");
      byId("magpie-port").focus();
      return;
    }
    const button = byId("model-fetch");
    button.disabled = true;
    status.textContent = text("fetchingModels");
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/v1/models", { headers: { authorization: "Bearer " + key, "x-magpie-agent": "octopus-ly-connector:v" + VERSION } });
      if (response.status === 401 || response.status === 403) {
        status.textContent = text("fetchModelsAuth");
        return;
      }
      if (!response.ok) throw new Error("HTTP " + response.status);
      const body = await response.json();
      const ids = Array.isArray(body && body.data) ? body.data.map((entry) => entry && entry.id).filter((id) => typeof id === "string" && id) : [];
      let added = 0;
      for (const id of ids) if (controller.addModel(id)) added += 1;
      status.textContent = fill("fetchedModels", { count: added });
    } catch {
      status.textContent = text("fetchModelsFailed");
    } finally {
      updateFetchButton();
    }
  }

  const bridge = window.magpie;
  applyTheme(bridge && bridge.theme);
  if (!bridge) {
    byId("message").textContent = text("missingBridge");
    byId("saved-state").textContent = text("noState");
    return;
  }
  bridge.onTheme(applyTheme);
  const controller = window.OctopusController.createController({ bridge, onChange: (state) => { paint(state); updateFetchButton(); } });

  const fields = () => ({
    cloud_url: byId("cloud-url").value,
    models: controller.getState().draft,
    max_concurrency: byId("concurrency").value,
    request_timeout_seconds: byId("timeout").value,
    node_token: byId("node-token").value,
    magpie_key: byId("magpie-key").value,
    magpie_port: byId("magpie-port").value,
  });

  function submitModel() {
    const input = byId("model-input");
    const line = input.value;
    if (controller.addModel(line)) { input.value = ""; input.focus(); }
  }
  byId("model-add").addEventListener("click", submitModel);
  byId("model-input").addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); submitModel(); }
  });
  byId("model-input").addEventListener("input", function () { controller.clearDraftError(); });
  byId("model-fetch").addEventListener("click", fetchModels);
  byId("magpie-key").addEventListener("input", updateFetchButton);
  byId("magpie-port").addEventListener("input", updateFetchButton);

  for (const action of ["save", "connect", "disconnect"]) {
    byId(action).addEventListener("click", function () {
      if (controller.request(action, fields())) {
        byId("confirm").focus();
      } else {
        const field = controller.getState().errors.find((error) => fieldIDs[error]);
        if (field) byId(fieldIDs[field]).focus();
      }
    });
  }
  byId("confirm").addEventListener("click", function () { void controller.confirm(); });
  byId("cancel").addEventListener("click", controller.cancel);
  byId("retry").addEventListener("click", function () { void controller.load(); });
  byId("setup-close").addEventListener("click", function () { controller.dismissSetup(); });
  void controller.load();
})();
