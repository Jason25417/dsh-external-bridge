# dsh-external-bridge

[![test](https://github.com/Jason25417/dsh-external-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/Jason25417/dsh-external-bridge/actions/workflows/test.yml) [![dsh](https://img.shields.io/badge/dsh-0.2.x-4b8dff)](https://github.com/deepseek-ai/deepseek-harness) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)


在本机 **127.0.0.1:39217** 开一个 HTTP 口子，让外部进程（终端里的 Claude Code 等）指挥**桌面版 DSH 主进程**干活：建会话（可选 agent preset / 模型）、发消息、查状态、长轮询等回复。

建出来的会话走宿主自己的 `sessionController.create`，是 GUI 里的**真会话**：会出现在对应工作区的侧栏，用户点进去能看到消息与回复实时滚动，与手动新建没有区别。`dsh headless` 建的会话只落盘 `~/.dsh/sessions/`、不进 `workspace.json` 注册表，GUI 里看不到——那正是本插件要补的缺口。

**不改 DSH 本体、不改 `@yunmiao/studymate`。** 只新增目录 `~/.dsh/profiles/desktop/plugins/dsh-external-bridge/`。

---

## 为什么不用宿主自带的 HTTP 口

桌面宿主的 Web 口（如 `127.0.0.1:50186`、`*:3081`）对**没有凭据**的请求一律回 `401 unauthorized`，外部进程拿不到 GUI 客户端的凭据。所以本插件不挂 `connection.fetch`，自己用 `node:http` 起一个只绑 loopback 的监听，配一枚随机 Bearer token（0600 落盘），与 GUI 的鉴权彻底分开。

- 只绑 `127.0.0.1`，端口固定 `39217`；**被占就启动失败**并在日志里说清楚，不静默换端口。
- 启动时生成随机 token（32 字节，base64url），写到 `~/.dsh/secrets/external-bridge.token`（目录 0700、文件 0600）。
- 每个请求都必须带 `Authorization: Bearer <token>`，不带或不对回 `401`。
- 插件 dispose 时关闭监听。

---

## 接口

所有响应都是 JSON。失败一律是：

```jsonc
{ "ok": false, "error": { "code": "machine-readable-code", "message": "人读的一句话" } }
```

| 路由 | 作用 |
|---|---|
| `GET /health` | `{ ok, version, presets, models }`；拿不到的字段回 `null`，不编 |
| `POST /sessions` | 建会话，回 `{ sessionId, agentPreset?, workspaceId?, model?, firstPrompt?, warning? }` |
| `POST /sessions/:id/prompt` | 发消息，回接收回执（不是回复） |
| `GET /sessions/:id` | `{ state, lastAssistantText, turnCount, error? }` |
| `GET /sessions/:id/wait?timeoutMs=` | 长轮询：空闲/出错立即返回（内容同上）；超时回 `{ state: "running", timedOut: true }` |
| `GET /sessions` | 列工作区与会话 id |

### `GET /health`

```jsonc
{
  "ok": true,
  "version": "0.2.0",
  "presets": ["standard", "learning", "qa"],        // 可用（非 broken）的 preset id；服务缺失时 null
  "models": ["opencode-go-4/deepseek-v4-pro", "…"]    // provider/model 摊平；目录拿不到时 null
}
```

### `POST /sessions`

```jsonc
// 入参（cwd 与 workspaceId 二选一，必须给一个）
{
  "workspaceId": "ws_xxx",        // 二选一：已注册工作区 id（推荐，保证侧栏可见）
  // "cwd": "/abs/path",          // 二选一：目录；命中已注册工作区时内部改走 workspaceId
  "agentPreset": "studymate",     // 可选；studymate 是 learning 的显式别名（见下）
  "provider": "opencode-go-4",    // 可选，与 model 同时给
  "model": "deepseek-v4-pro",
  "reasoningEffort": "max",       // 可选，只在给了 provider+model 时有效
  "firstPrompt": "只回复两个字：收到"  // 可选，建完即投递（queue 模式）
}
// 成功
{ "ok": true, "sessionId": "session-…", "agentPreset": "learning", "workspaceId": "ws_xxx",
  "model": { "provider": "opencode-go-4", "model": "deepseek-v4-pro", "reasoningEffort": "max" },
  "firstPrompt": { "accepted": true } }
```

- `cwd` 不属于任何已注册工作区时仍会建会话，但回包里带 `warning`：GUI 侧栏可能不显示它（会话确实存在）。要进侧栏，先给它建工作区，或改用 `workspaceId`。
- 指定模型失败（如模型不可用）时回错误，但**带 `sessionId`**，调用方可以接上继续用或自行处理。

### `POST /sessions/:id/prompt`

```jsonc
// 入参
{ "message": "继续", "mode": "queue" }   // mode: queue（默认）| steer
// 成功
{ "ok": true, "sessionId": "…", "requestId": "bridge-prompt-…", "mode": "queue", "receipt": { "accepted": true } }
```

### `GET /sessions/:id` 与 `GET /sessions/:id/wait`

```jsonc
{
  "ok": true,
  "sessionId": "…",
  "state": "running",            // running | idle | error
  "lastAssistantText": "…",      // 最后一条**带正文**的助手回复；工具调用行不算
  "turnCount": 3,                // 已完成的回合数
  "error": { "code": "RATE_LIMIT", "message": "上游限流" }   // 仅当最后一轮以 error 结束时
}
```

- `wait` 默认等 30 秒，`timeoutMs` 上限 240 秒（压在 Node 默认 `requestTimeout` 300s 内）。
- 客户端断开时，桥会中止它这边的等待，不把宿主读操作挂住。

### `GET /sessions`

```jsonc
{ "ok": true, "workspaces": [ { "id": "ws_xxx", "title": "默认工作区", "path": "/Users/…", "sessionIds": ["session-…"] } ] }
```

### 错误码

| `code` | HTTP | 含义 |
|---|---|---|
| `unauthorized` | 401 | 缺 token / token 不对 |
| `body-invalid` / `bad-request` | 400 | 请求体不是 JSON 对象 / 参数不合法（消息里写清哪一项） |
| `body-too-large` | 413 | 请求体超过 1 MiB |
| `not-found` | 404 | 路由不存在 |
| `method-not-allowed` | 405 | 路径存在但方法不对 |
| `session/not-found` / `workspace/not-found` | 404 | 会话/工作区不存在 |
| `agent-preset/not-found` | 400 | 预设不存在；`message` 里列可用 id |
| `session/model-unavailable` | 400 | 模型不可用（同时带 `sessionId`） |
| `service-unavailable` | 503 | 宿主服务缺失/未就绪（哪条服务、为什么，写在 message 里） |
| `token-unavailable` | 503 | token 文件写不了；监听仍在，但所有请求都回这个 |
| `port-unavailable` | — | 启动期错误（只在宿主日志里）：端口被占 |
| `internal` | 500 | 其它意外；message 带原始错误 |

---

## 两个问题的结论（查过代码，不是猜的）

### 1. 怎么给会话指定模型

- `sessionController.create()` **不接受**任何模型字段（`dsh-api-session-controller/lib/index.js` 的 `create(request)`：只认 `sessionId / workspaceId / cwd / agentPreset`）。所以「建会话时顺带指定模型」在宿主接口里不存在。
- GUI 的模型菜单走的是另一个 RPC：`sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })`
  （客户端 `@deepseek-ai/dsh-client-ui-model-selection/lib/client.js` 调 `this.sessions.selectModel(...)`）。
  本桥的顺序：`create` → `selectModel`。
- 注意：`selectModel` 内部会**顺手把这次选择存成全局默认模型**（`SessionCommandController.selectModel` →
  `agentDefaultModel.saveSelection`）。外部调用不应该悄悄改掉用户 GUI 的默认模型，所以桥在成功后
  把**原来的默认值**写回（`agentDefaultModel.currentSelection()` / `saveSelection()`）。
  `saveSelection` 的写入是排队提交的，因此「先存新值、后存旧值」的顺序可靠。
- 可用模型清单：`sessionController.modelCatalog()` → `{ groups: [{ id, name, models: [{ id, name, reasoning }] }], default, failures }`。
  `/health.models` 就是它摊平成 `provider/model`。
- 想指定「DeepSeek 账号 · V4-Pro · Max」：`provider` 用 `opencode-go-4` 之类（以 `/health` 的清单为准），
  `model: "deepseek-v4-pro"`，`reasoningEffort: "max"`。

### 2. 怎么读会话状态与最后一条助手消息

宿主里能给出这些的是 **`sessionController`（RPC 门面）+ `sessionQuery`（底层被动读）**：

- 进程内状态：`sessionController.state({ sessionId })` → `{ cursor, active, running, queue, pendingInput }`。
  `running` 就是 `/sessions/:id` 的 running 依据。
- 长轮询：`sessionController.wait({ sessionId, timeoutMs, afterSeq, maxMessages })` →
  `{ reason: "idle" | "input-required" | "timeout", state, output: { records, truncated } }`。
  `output.records` 是 **newest-first** 的 `assistant/message` 事件（每条是 `{ type: "event", event }`），
  正文在 `event.data.message.content[]` 里 `type === "text"` 的块。
  超时不是抛错在上层，而是 `reason: "timeout"` / `RemoteError code session/wait-timeout`
  （冻结在代码里的时间点不同，两种都处理了）。
- 完整事件表（冷/热都读、不激活会话）：`sessionQuery.observeSession(sessionId, { projectionMode: "none" })`
  → observation，含 `events` / `cursor` / `[Symbol.dispose]()`。
  兜底：`sessions.get(sessionId).snapshotEvents()`（只对活会话有效）。本桥先走前者，后者兜底。
- 回合数与错误：扫事件表——`turn/end` 计数即已完成回合数；
  最后一轮 `turn/end.data.reason.kind === "error"` 时，`reason.error` 里有 `{ code, message }`，桥把它填进 `error`。
  `aborted`（用户中断）不算 error。

> 为什么不直接用 `@deepseek-ai/dsh-session` 的 Session 对象硬扫：`sessionId` 可能是冷会话（只在磁盘上），
> `sessionQuery.observeSession` 才是冷热通吃的读口；而且它不会把会话「激活」成活的 Agent。

---

## 挂载（由你操作；我没有改 profile、没有重启宿主）

> 已打包为 bundle（`package.json` 的 `dsh.bundle`）后，推荐直接安装，不用手工改 profile：
> `dsh plugin --profile desktop add dsh-external-bridge`（npm 包 / tarball / 本地路径均可），然后完全退出并重开 DSH Desktop。
> 下面这段手工挂载保留给源码 checkout 场景。

1. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` **末尾**追加：

```yaml
# --- 2026-11-05: 外部桥（本机 HTTP，供终端里的 Claude Code 指挥桌面 DSH）---
# 只挂 file:// 的 Host 半；没有 client 半，不需要软链进 node_modules。
# 回滚：删掉本段，完全退出并重开 DSH Desktop。
- insert:
    - id: external-bridge
      name: file:///path/to/dsh-external-bridge/index.js
```

2. 完全退出并重开 DSH Desktop（Host 插件只在启动时挂载）。

3. 验证：

```bash
test -f ~/.dsh/secrets/external-bridge.token && ls -l ~/.dsh/secrets/external-bridge.token
TOKEN=$(cat ~/.dsh/secrets/external-bridge.token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:39217/health | jq
```

看到 `{"ok":true,"version":"0.2.0","presets":[…],"models":[…]}` 就是起来了。

4. 排错：宿主日志里搜 `[dsh-external-bridge]` 或 `external bridge`。
   - `无法监听 127.0.0.1:39217` → 端口被别的进程占了（`lsof -nP -iTCP:39217 -sTCP:LISTEN`）。
   - `token 文件写不了` → `~/.dsh/secrets/` 权限/磁盘问题；此时接口全回 503 `token-unavailable`。

## 回滚

```bash
# 1) 删掉 cordis.patch.yml 里 `# --- 2026-11-05: 外部桥` 起的那 6 行
# 2) 完全退出并重开 DSH Desktop
# 3) （可选）删掉 token
rm -f ~/.dsh/secrets/external-bridge.token
# 4) （可选）删掉插件目录
rm -rf ~/.dsh/profiles/desktop/plugins/dsh-external-bridge
```

改 patch 前建议先备份：`cp ~/.dsh/profiles/desktop/cordis.patch.yml ~/.dsh/profiles/desktop/cordis.patch.yml.bak-before-external-bridge-$(date +%Y%m%d-%H%M)`。

## curl 冒烟流程（挂载后）

```bash
TOKEN=$(cat ~/.dsh/secrets/external-bridge.token)
BASE=http://127.0.0.1:39217
AUTH="Authorization: Bearer $TOKEN"

# 0) 健康检查
curl -s -H "$AUTH" $BASE/health | jq

# 1) 拿一个工作区 id（没建过会话的工作区也可以，只要已注册）
WS=$(curl -s -H "$AUTH" $BASE/sessions | jq -r '.workspaces[0].id')
echo "workspace: $WS"

# 2) 建一个学习模式会话，并投递第一句
SESSION=$(curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"agentPreset\":\"studymate\",\"firstPrompt\":\"只回复两个字：收到\"}" \
  $BASE/sessions | tee /tmp/bridge-create.json | jq -r '.sessionId')
cat /tmp/bridge-create.json | jq
echo "session: $SESSION"

# 3) 等它跑完（默认 30s，最长 240s）
curl -s -H "$AUTH" "$BASE/sessions/$SESSION/wait?timeoutMs=120000" | jq

# 4) 再读一次状态与最后回复
curl -s -H "$AUTH" "$BASE/sessions/$SESSION" | jq '{state,lastAssistantText,turnCount}'
```

期望：第 2 步回 `agentPreset: "learning"`；第 3 步 `state: "idle"` 且 `lastAssistantText` 是「收到」；
同时 GUI 侧栏对应工作区里出现这条新会话，点进去能看到消息与回复。

---

## 测试

```bash
cd ~/.dsh/profiles/desktop/plugins/dsh-external-bridge
node --test tests/*.test.mjs     # 或 npm test
```

35 项全绿（鉴权 / 路由 / 参数校验 / 错误信封 / 建会话别名 / 模型选择与默认恢复 /
状态与 wait / 端口占用 / token 写不了 / 日志不落正文 / readBody 超限）。

**没跑的部分**：真实挂载后的 curl 冒烟（上面那段）。因为本插件尚未被挂载、宿主也未重启，
跑不了真宿主上的 `/health`、真会话创建与 wait。测试里用的是**假 ctx + 真的 http.Server**：
路由、鉴权、参数、信封、日志都覆盖了；唯一没验证的是「宿主真实服务的方法名/返回字段是否与
`dsh-api-session-controller` 源码一致」——挂载后第一件事就是跑冒烟流程确认。

补一句结构说明：`apply()` 只做三件事（取 logger、起/关 server、用 `ctx.effect` 登记 disposer），
所有可测逻辑都在 `startBridge()` / 请求处理器里；`apply` 本身没有单测（它会绑固定端口 39217），
靠挂载后的冒烟覆盖。

## 已知边界

- **预设别名**：`studymate` → `learning` 是显式映射（宿主 `session_create` 工具文档里写作 `studymate`，
  注册表里的真实 id 是 `learning`）。仅当注册表里没有同名 id 时生效；`/health.presets` 里给的是真实 id。
  其它 preset id 原样传递，不存在就报 `agent-preset/not-found` 并列出可用 id。
- **模型选择会短暂改写默认模型再恢复**：恢复失败只在日志 warn，接口不报（会话的模型仍然是对的）。
- **cwd 不在任何已注册工作区**时，会话能建但侧栏可能不显示，回包带 `warning`。
- **状态读取会 materialize 整条会话事件**（`sessionQuery.observeSession` 的 `events`）：超长会话有
  内存/耗时成本；`turnCount` 必须全量扫，暂未做分页优化。
- **宿主刚启动的瞬间** `/health.presets` / `models` 可能还是 `null`（服务未就绪），等一两秒再请求即可。
- **wait 上限 240s**，超过请自己循环（客户端断开后桥会中止等待，不残留）。
- **token 每次 Host 启动都会重新生成**，旧 token 立即失效；重启后外部脚本要重新读文件。
- **端口固定 39217**，被占即启动失败（不换端口），日志里会写明 errno。
- 只绑 loopback；HTTP 无 TLS（本机回环）。不联网、不上报；日志只记路由/会话 id/耗时/结果码，**不记消息正文**。
- 没有对 `sessionId` 做格式白名单，非法 id 由宿主报 `session/not-found`（避免桥和宿主两套校验打架）。
