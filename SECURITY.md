# Security Policy

`dsh-external-bridge` is a **host-side DSH plugin that opens a local HTTP listener**. It is a local
automation surface for processes running as the same user, not a remote service.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.2.x | Yes |
| < 0.2 | No |

The bridge also requires a compatible DSH host (`engines.dsh` in `package.json`).

## Design

- **Loopback only.** The listener binds `127.0.0.1:39217`; it never binds `0.0.0.0` or a public
  interface. There is no TLS because the traffic never leaves the loopback interface.
- **Bearer token on every request.** At host start the plugin generates 32 random bytes
  (`crypto.randomBytes(32).toString('base64url')`) and requires
  `Authorization: Bearer <token>`. Missing or wrong tokens get `401 unauthorized`.
- **Tight file permissions.** The token is written to
  `$DSH_HOME/secrets/external-bridge.token` (`~/.dsh/secrets/` by default) with the directory
  `0700` and the file `0600`, via a temp file + `rename` so a crash cannot leave a half token.
- **Constant-time comparison.** `crypto.timingSafeEqual` is used, and length mismatches are
  rejected first.
- **Token rotation.** A new token is minted on every host start; the previous token stops working
  immediately. External scripts must re-read the file after a restart.
- **No outbound network.** The plugin imports only `node:*` built-in modules. It makes no HTTP
  requests, sends no telemetry, and has no update check.
- **No message content in logs.** Log lines contain route, session id, duration, HTTP status and
  error code only. Prompt text and assistant replies are never written to logs.
- **Bounded input.** JSON bodies are capped at 1 MiB (`413 body-too-large`), messages at 200,000
  characters, and `wait` at 240 seconds. Requests are JSON objects only.
- **Clean lifecycle.** The listener is closed from the plugin dispose hook.
- **Zero third-party runtime dependencies.** The package does not import any `@deepseek-ai/*`
  internal package either; host services are fetched lazily from the plugin context.

## Threat model — what this does not protect against

- **Same-user local processes.** Anything running as your OS user can read the token file and
  drive the bridge: create sessions, send prompts (which spend model tokens), and read session
  state and replies. `0600` protects against other users, not against local malware running as you.
- **root / Administrator.** These can always read the token.
- **Exposure through proxies.** Do not forward, tunnel, reverse-proxy, or port-forward port 39217.
  The listener has no TLS and the token is its only authentication.
- **No per-caller identity or rate limits** beyond the body/message caps. This is a single-user
  bridge, not a multi-tenant API.
- **Session content is not encrypted by the bridge.** It reads the same session data the GUI
  already stores; the bridge adds no encryption at rest.

## Reporting a vulnerability

Once the repository is public, open a private security advisory at
<https://github.com/Jason25417/dsh-external-bridge/security/advisories/new>.
Please do not open a public issue for an unpatched vulnerability. Include the DSH version, the
bridge version, and reproduction steps.
