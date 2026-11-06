# dsh-external-bridge

A local HTTP bridge for **DSH Desktop**: it opens a listener on `127.0.0.1:39217` so that external
processes (Claude Code in a terminal, scripts, CI) can drive the running desktop host — create
sessions (optionally with an agent preset and a model), send prompts, read state, and long-poll for
the reply.

Sessions created through the bridge go through the host's own `sessionController.create`, so they
are **real sessions in the GUI**: they show up in the matching workspace's sidebar and stream
messages and replies live, exactly like a manually created session. Sessions created by
`dsh headless` only land in `~/.dsh/sessions/` and are not registered in `workspace.json`, so the
GUI does not show them — that is the gap this plugin fills.

The plugin **does not patch DSH itself** and does not touch `@yunmiao/studymate`. It only adds a
host-side plugin package.

- Requires **DSH `>=0.2.1-rc.0 <0.3.0`** and **Node.js >= 22**.
- Host half only: no client bundle, no browser code, no build step, no install scripts.
- Zero runtime dependencies; imports only `node:*` built-ins.
- Version: **0.2.0**.

## Why a separate HTTP port

The desktop host's own web port (e.g. `127.0.0.1:50186`, `*:3081`) answers `401 unauthorized` to
requests that carry no GUI credentials, and an external process cannot obtain those credentials. So
this plugin does not hook `connection.fetch`; it starts its own `node:http` listener bound to
loopback only, guarded by a random Bearer token stored with `0600` permissions. GUI authentication
and bridge authentication are fully separate.

- Binds `127.0.0.1` only, fixed port `39217`. If the port is taken, startup **fails loudly** in the
  host log and the plugin does not silently pick another port.
- Mints a fresh random token on every host start (32 bytes, base64url) and writes it to
  `~/.dsh/secrets/external-bridge.token` (directory `0700`, file `0600`, atomic rename).
- Every request must carry `Authorization: Bearer <token>`; missing or wrong tokens get `401`.
- The plugin's dispose hook closes the listener.

## Install

Published as the npm package `dsh-external-bridge`. Install it as a profile bundle:

```sh
# from npm (once published)
dsh plugin --profile desktop add dsh-external-bridge

# or from a prebuilt tarball
dsh plugin --profile desktop add ./dsh-external-bridge-0.2.0.tgz

# or from a local checkout
dsh plugin --profile desktop add ./path/to/dsh-external-bridge
```

Then **fully quit and reopen DSH Desktop**: host plugins are mounted at host startup. The manifest
declares `dsh.bundle.patch` (`./cordis.patch.yml`), which inserts the `external-bridge` row; the
package name resolves through Node, so the row works for npm, tarball and linked installs alike.

Verify the bridge is up:

```sh
ls -l ~/.dsh/secrets/external-bridge.token        # -rw------- (0600)
TOKEN=$(cat ~/.dsh/secrets/external-bridge.token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:39217/health
```

A `{"ok":true,"version":"0.2.0","presets":[…],"models":[…]}` response means the bridge is running.

Uninstall:

```sh
dsh plugin --profile desktop remove dsh-external-bridge
# restart DSH Desktop; optionally remove the token file:
rm -f ~/.dsh/secrets/external-bridge.token
```

## Quick start

```sh
TOKEN=$(cat ~/.dsh/secrets/external-bridge.token)
BASE=http://127.0.0.1:39217
AUTH="Authorization: Bearer $TOKEN"

# 0) health
curl -s -H "$AUTH" $BASE/health | jq

# 1) pick a registered workspace id
WS=$(curl -s -H "$AUTH" $BASE/sessions | jq -r '.workspaces[0].id')

# 2) create a learning-mode session and deliver the first prompt
SESSION=$(curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"agentPreset\":\"studymate\",\"firstPrompt\":\"Reply with just: got it\"}" \
  $BASE/sessions | tee /tmp/bridge-create.json | jq -r '.sessionId')

# 3) wait for the turn to finish (default 30 s, max 240 s)
curl -s -H "$AUTH" "$BASE/sessions/$SESSION/wait?timeoutMs=120000" | jq

# 4) read state and the last assistant reply
curl -s -H "$AUTH" "$BASE/sessions/$SESSION" | jq '{state,lastAssistantText,turnCount}'
```

Expected: step 2 reports `agentPreset: "learning"`; step 3 returns `state: "idle"` with the reply
in `lastAssistantText`; the new session appears in that workspace's sidebar in the GUI.

## API

All responses are JSON. Failures always use:

```jsonc
{ "ok": false, "error": { "code": "machine-readable-code", "message": "one human-readable sentence" } }
```

| Route | Purpose |
| --- | --- |
| `GET /health` | `{ ok, version, presets, models }`; fields the host cannot provide are `null`, never invented |
| `POST /sessions` | Create a session; returns `{ sessionId, agentPreset?, workspaceId?, model?, firstPrompt?, warning? }` |
| `POST /sessions/:id/prompt` | Send a prompt; returns a receipt (not the reply) |
| `GET /sessions/:id` | `{ state, lastAssistantText, turnCount, error? }` |
| `GET /sessions/:id/wait?timeoutMs=` | Long-poll: returns immediately when idle/errored (same payload); on timeout returns `{ state: "running", timedOut: true }` |
| `GET /sessions` | List workspaces and their session ids |

### `GET /health`

```jsonc
{
  "ok": true,
  "version": "0.2.0",
  "presets": ["standard", "learning", "qa"],        // usable (non-broken) preset ids; null if the service is missing
  "models": ["opencode-go-4/deepseek-v4-pro", "…"]  // provider/model flattened; null if the catalog is unavailable
}
```

### `POST /sessions`

```jsonc
// input (exactly one of cwd / workspaceId)
{
  "workspaceId": "ws_xxx",        // registered workspace id (recommended: guarantees sidebar visibility)
  // "cwd": "/abs/path",          // or a directory; if it matches a registered workspace, the bridge uses its id
  "agentPreset": "studymate",     // optional; studymate is an explicit alias for learning (see below)
  "provider": "opencode-go-4",    // optional, together with model
  "model": "deepseek-v4-pro",
  "reasoningEffort": "max",       // optional; only meaningful with provider+model
  "firstPrompt": "Reply with just: got it"  // optional; delivered right after creation (queue mode)
}
// success
{ "ok": true, "sessionId": "session-…", "agentPreset": "learning", "workspaceId": "ws_xxx",
  "model": { "provider": "opencode-go-4", "model": "deepseek-v4-pro", "reasoningEffort": "max" },
  "firstPrompt": { "accepted": true } }
```

- If `cwd` is not inside any registered workspace the session is still created, but the response
  carries a `warning`: the GUI sidebar may not show it (the session does exist). Create a workspace
  for that directory, or pass `workspaceId` instead.
- If selecting the model fails (e.g. the model is unavailable), the request returns an error **with
  the `sessionId`** so the caller can still use the created session.

### `POST /sessions/:id/prompt`

```jsonc
// input
{ "message": "continue", "mode": "queue" }   // mode: queue (default) | steer
// success
{ "ok": true, "sessionId": "…", "requestId": "bridge-prompt-…", "mode": "queue", "receipt": { "accepted": true } }
```

### `GET /sessions/:id` and `GET /sessions/:id/wait`

```jsonc
{
  "ok": true,
  "sessionId": "…",
  "state": "running",            // running | idle | error
  "lastAssistantText": "…",      // last assistant reply that has text; tool-call rows are skipped
  "turnCount": 3,                // completed turns
  "error": { "code": "RATE_LIMIT", "message": "upstream rate limit" }   // only when the last turn ended in error
}
```

- `wait` defaults to 30 seconds; `timeoutMs` is capped at 240 seconds (inside Node's default
  `requestTimeout` of 300 s).
- If the client disconnects, the bridge aborts its own wait and does not leave a host read hanging.

### `GET /sessions`

```jsonc
{ "ok": true, "workspaces": [ { "id": "ws_xxx", "title": "Default workspace", "path": "/Users/…", "sessionIds": ["session-…"] } ] }
```

### Error codes

| `code` | HTTP | Meaning |
| --- | --- | --- |
| `unauthorized` | 401 | Missing or wrong token |
| `body-invalid` / `bad-request` | 400 | Body is not a JSON object / parameters are invalid (the message names the field) |
| `body-too-large` | 413 | Body exceeds 1 MiB |
| `not-found` | 404 | Unknown route |
| `method-not-allowed` | 405 | Route exists but the method is wrong |
| `session/not-found` / `workspace/not-found` | 404 | Unknown session/workspace |
| `agent-preset/not-found` | 400 | Unknown preset; the message lists the available ids |
| `session/model-unavailable` | 400 | Model unavailable (response still carries `sessionId`) |
| `service-unavailable` | 503 | Host service missing/not ready (which service and why are in the message) |
| `token-unavailable` | 503 | Token file cannot be written; the listener is up but every request returns this |
| `port-unavailable` | — | Startup error (host log only): port is taken |
| `internal` | 500 | Anything else; the message carries the original error |

### Limits

- JSON body: 1 MiB (`413` beyond that); message: 200,000 characters.
- `wait`: default 30 s, max 240 s.
- Port: fixed `39217`, loopback only; a busy port is a startup failure.

## Security

The listener is loopback-only, requires a Bearer token on every request, stores that token with
`0700`/`0600` permissions, compares it in constant time, makes no outbound network calls, and never
logs message bodies. The token rotates on every host start. Do not expose port 39217 through a
proxy or tunnel: there is no TLS and the token is the only authentication.

Full threat model and reporting instructions: [SECURITY.md](./SECURITY.md).

## Tests

```sh
cd dsh-external-bridge
node --test tests/*.test.mjs     # or: npm test
```

35 tests cover authentication, routing, parameter validation, error envelopes, the preset alias,
model selection with default-model restore, state and long-poll wait, port-in-use, token
write failure, "no message body in logs", and the request-body cap. They use a fake plugin context
plus a real `http.Server` on port 0, so no running DSH host is needed.

Not covered by the unit tests: the post-install curl smoke test against a real host (the plugin must
be mounted and the app restarted). Run the "Quick start" block once after installing.

## Screenshots

Storefronts (for example dsh-market's detail view) read screenshots declared in this repository.
This is intentionally a **placeholder** — no images are committed yet:

1. Add 1–8 PNG/JPG/WEBP files under `assets/` (suggested: `assets/screenshot-1.png` …).
2. Add `screenshots.json` next to `package.json`:

   ```jsonc
   ["assets/screenshot-1.png", "assets/screenshot-2.png"]
   ```

   Paths are relative to `screenshots.json`, must stay inside the repository, and must not start
   with `/` or contain `..`. Absolute URLs must be GitHub-hosted `https` links.
3. Suggested shots: the host log line showing the bridge listening, a `curl /health` response, a
   session created by the bridge visible in the GUI sidebar, and a `wait` response.
4. Optional storefront icon: `assets/icon-180.png` (square PNG, ~96 px display), referenced from the
   market entry as `icon:`. Without it, storefronts fall back to the GitHub avatar.

## Known limitations

- **Preset alias**: `studymate` → `learning` is an explicit mapping (the host's `session_create`
  tool documents it as `studymate`, while the registry id is `learning`). It applies only when the
  registry has no id with that name; `/health.presets` reports real ids. Other preset ids are passed
  through and unknown ones return `agent-preset/not-found` with the available ids.
- **Model selection temporarily rewrites the default model, then restores it.** If the restore
  fails it is only logged as a warning; the session's model is still correct.
- **`cwd` outside any registered workspace**: the session is created but the sidebar may not show
  it; the response carries a `warning`.
- **State reads materialize the whole session event list** (`sessionQuery.observeSession`); very
  long sessions cost memory/time, and `turnCount` scans everything (no pagination yet).
- **Right after host startup**, `/health.presets` and `models` can be `null` until the services are
  ready; retry in a second or two.
- **`wait` is capped at 240 s**; loop on the client side for longer turns (the bridge aborts its
  wait when the client disconnects).
- **The token is regenerated on every host start**; old tokens stop working and external scripts
  must re-read the token file.
- **The port is fixed**; if it is taken the plugin fails to start instead of moving (the host log
  names the errno).
- **Loopback only; no TLS.** The bridge does not connect out and does not report anything anywhere.
  Logs contain route/session id/duration/status only, never message bodies.
- **No format whitelist for `sessionId`**; invalid ids are reported by the host as
  `session/not-found`, so the bridge and the host do not fight over validation.

## License

MIT © Jason Tu. See [LICENSE](./LICENSE).
