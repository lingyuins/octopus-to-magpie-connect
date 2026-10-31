# Acceptance and boundaries

## Deliverable

This directory is an independent, local-installable Magpie community plugin. `index.mjs` runs supervision inside the existing Bun host and returns hooks immediately. It does not launch a Go Connector, spawn a child process, install a service, modify Magpie, or terminate its host.

The application code depends only on files in this directory and pinned `ws@8.22.0`. The actual npm library is resolved by file path to prevent Bun's bare `ws` compatibility alias from changing authentication/backpressure semantics.

## Evidence map

- `tests/config.test.mjs` / `protocol.test.mjs`: literal-loopback target, WSS/TLS and safe paths, credentials, model IDs/control characters, binary uint64 frames and header/path boundaries.
- `tests/transport.test.mjs` / `transport-handshake.test.mjs`: real WS Authorization/subprotocol/hello, HTTP streaming/SSE, cancellation/deadline, concurrency, duplicate request IDs, no replay, models projection, header isolation, request/metadata bounds, proxy/redirect rejection, untrusted TLS and actual 10-second blocked writer timeout.
- `tests/control.test.mjs`: precise installation identity, strict public options, explicitly supplied external private config, duplicate JSON rejection, Windows atomic replacement and existing Magpie retry compatibility.
- `tests/lease.test.mjs`: OS-owned exclusive loopback listeners, multi-process exclusion, owner death, copied installs using the same token, release of partially acquired leases.
- `tests/runtime.test.mjs`: initial-option pinning, permanent retirement on configuration changes, old/new host handoff with peak active sessions of one, exponential jitter/reset and immediate cancellation during backoff.
- `tests/entry.test.mjs`: immediate plugin return, no spawning/exiting host and fixed official diagnostic messages.
- Page/options/controller tests: real controller behavior, explicit confirmation, nine-field writes including credentials, secret masking with `__keep__` placeholder, themes, errors and fail-closed save acknowledgement.

## Connection usability regression coverage

- The plugin page accepts only a local port (1–65535) and constructs the fixed IPv4 loopback origin. Existing URL-based private configuration remains compatible.
- Clearing a page override now removes it; only the unchanged `__keep__` credential placeholder preserves a stored secret.
- Setup instructions and successful saves explicitly require fully quitting and restarting Magpie. Saving remains a preference, never a fake online indicator. Magpie source and bridge APIs are unchanged.
- Models-only tunnel errors use fixed diagnostic codes for unreachable local gateway, authentication failure, HTTP failure and malformed model lists; local error messages and response bodies are never reflected.
- Octopus node and node-channel connectivity probes use only `GET /v1/models`, not inference. Its real HTTP stack must bypass frontend static fallback for `/node/` and use the Gin-compatible WebSocket upgrade adapter. Regression tests cover both failures.

## Repository review fixes verified (2026-10-31)

- Installation identity: npm bare/version/tag/scoped specs and Git specs resolve to the real Magpie installation target. Package names alone never establish identity; exact Git dependency mapping, canonical directories and unique entries are checked. Explicit spec overrides and absolute-directory installs remain compatible. New control/runtime regressions failed against the previous implementation before passing after the fix.
- Local HTTP lifecycle: unexpected 101 upgrades are rejected and their sockets destroyed. Cancellation and response-before-close failures settle the worker; the session still waits for cleanup rather than bypassing it. Status codes outside 200–599 never become RESPONSE frames. Real local HTTP/raw TCP + WebSocket tests cover slot reuse, concurrent requests, deadlines, stop and normal status boundaries; the old implementation failed the 101 and 600/999 regressions without hanging the test process.
- Model discovery: the page no longer attempts network requests. Magpie's CSP remains `connect-src 'none'`; its current official page bridge has no model-directory read. Users can query `/v1/models?format=text` in a local terminal and paste the result, or paste the JSON models response. Atomic imports enforce 4 MiB UTF-8 input and 1024 unique exact IDs, skip duplicates and leave the draft unchanged on any invalid item. Importing does not save or connect automatically.
- Initial language: the page applies the theme returned by asynchronous `ready` even when no initial `onTheme` event is sent, without overwriting a newer event. The test bridge now starts with `theme=null`, supports delayed hello and no longer overrides `fetch`. Both the initial-Chinese and old-network-action regressions failed before the page fix.
- The model-list command preview now follows the unsaved/saved port field (empty defaults to 3425), with a Copy command button. It uses Clipboard API with a user-gesture copy fallback for restricted frames, does not read credential fields and never saves options. Invalid ports, duplicate clicks, clipboard denial and stale feedback after port changes are covered. Browser verification confirmed the 4567-port preview and the browser-reported copy success in the sandbox; independent clipboard readback was denied by that sandbox, so no OS clipboard readback is claimed.
- Final complete suites after the copy-command addition: Node v24.21.0 `npm test` **135 passed, 0 failed, 0 skipped**; existing cached Bun v1.4.4 **129 passed, 0 failed** across 11 files. Node counts six nested cases separately; Bun reports their parent tests.
- JS/MJS syntax checks, `git diff --check` and `npm pack --dry-run --json` passed. The package dry-run contains 17 deliverable files and no test fixture. Git emitted only its LF-to-CRLF conversion notices.
- Browser verification served the real page with the test-only bridge and unchanged sandbox CSP on an isolated random loopback port. It covered initial Chinese, explicitly delayed hello without a theme event, later English switching, CRLF-list deduplication, JSON import, whole-batch rejection of an invalid ID, zero writes before confirmation and a confirmed nine-field save with `connect=false`. The native `fetch` was not replaced. The existing fixed preview port was already occupied; that unrelated process was left untouched.
- PowerShell header construction from a synthetic SecureString was checked locally. No request to the user's real gateway, real credentials, plugin installation, production cloud or paid inference was used. The temporary test server was stopped. No dependency, Magpie/Octopus source, git commit or publication changes were made.

## Usability verification (2026-10-30)

- Connector under Node: 92 tests passed, including port boundaries, clearing overrides, Chinese/English restart feedback and fixed diagnostic codes. Bun was not available in this verification run.
- Octopus: full Go suite, scoped vet, Windows CGO-disabled build, frontend type check, i18n parity, 368 frontend unit tests and production frontend build passed. Lint has zero errors and 14 existing warnings outside the changed UI.
- Regression tests reproduced both actual-server blockers before the fixes: frontend fallback returned a 301 for the node handshake; Gin 1.11 rejected the flushed WebSocket response before hijacking. The corrected full Gin route registers the node and completes the fixed models probe.
- Browser checks used a temporary database, synthetic account and in-memory tunnel peers: nodes online, successful models probe, rejected local key, empty allowed models, offline node, and channel editor showing the full failure reason. Plugin-page checks used the test-only bridge and verified invalid port feedback, confirmation and explicit restart instructions after saving.
- Temporary servers were stopped. No real Magpie installation/configuration, production cloud, live credentials or paid inference was used; Magpie source and its official bridge were not changed.

## Earlier executed checks

- Node v24.21.0: full independent suite, 84 passed.
- Bun v1.4.4: full independent suite, 84 passed. Used an isolated npm-cache executable, not a global installation change.
- npm audit: zero known vulnerabilities in installed pinned dependencies at verification time; this is not a complete security audit.
- Actual Go cloud `Manager` paired with this plugin's `connectOnce` under Bun: models filtering, JSON, incremental SSE, bidirectional header isolation, cancellation, uncertain execution after disconnect and reconnect without replay passed. Enabled explicitly in Octopus with `OCTOPUS_NODE_PLUGIN_TEST_MODULE` and `OCTOPUS_NODE_PLUGIN_RUNTIME`; normal Octopus tests do not require this checkout.
- Octopus after local-client removal: `pnpm check`, web TypeScript, production build, scoped Go vet, JSONiter regressions and CGO-disabled server build passed. Frontend unit tests: 365; lint retains 14 pre-existing warnings with zero errors.

## Browser acceptance

Served actual plugin page assets on a temporary loopback-only HTTP server with `connect-src 'none'` and the test-only Magpie bridge fixture. Normal browser controls loaded defaults, accepted a synthetic WSS URL/model, requested explicit connection confirmation and saved only public controls. Saved state clearly remained a preference, not a live-status indicator. Chinese/dark-theme behavior and disconnect confirmation/saved disconnected state were observed. The page explains in-host execution and lazy host/reload limitations rather than requiring a companion process.

This was a simulated bridge acceptance, not a real Magpie installation. No live key, production cloud or paid model was used. The temporary browser server and build artifacts were stopped/removed.

## Octopus cleanup

Removed obsolete local Go program `connector/`, external watcher `internal/magpieplugin/`, old in-repository page-only package `integrations/magpie/octopus-connector/`, and production `internal/nodetransport/connector.go` plus local-only tests. Cloud Manager/protocol, nodes/auth/migrations/audit/backups, channel binding and relay were retained. Cloud tests now use a test-only in-memory protocol peer, not a production local proxy. The pre-existing committed WASM plugin system was not removed. The cloud UI setup reference now separates `plugin_options` and `private_config` and no longer instructs running the deleted CLI.

## Not performed / limitations

- No installation into the user's real Magpie, no existing credentials read, no production deployment or real paid inference.
- Magpie's Bun host is lazy. The plugin only runs after Magpie loads it. Saving options may reload the host and fail active requests; requests are never replayed.
- Secrets must be supplied before launching Magpie or through an explicitly selected external private file. A changed private file retires the old runtime; reload the host to activate new credentials.
- The OS leases are loopback listeners with no HTTP/control API. Hash-port conflicts fail closed rather than taking another process's ownership.
- Windows read handles can momentarily block replacement. Magpie's existing atomic writer retries these conflicts; external editors must also handle transient EPERM.
- No process-level race-detector claim. No npm publication, git commit, push or global Bun installation performed.
