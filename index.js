/**
 * dsh-external-bridge — Host 半。
 *
 * 在本机 127.0.0.1:39217 上开一个 HTTP 口子，让外部进程（例如终端里的 Claude Code）
 * 指挥**桌面版 DSH 主进程**干活：建会话（可选 agent preset / 模型）、发消息、查状态、
 * 长轮询等回复。建出来的会话就是 GUI 里的真会话（走 `sessionController.create`），
 * 会出现在对应工作区的侧栏，用户点进去能看到消息与回复实时滚动。
 *
 * 为什么不用宿主自带 HTTP 口、也不挂 `connection.fetch`：
 * 桌面宿主的 Web 口（如 127.0.0.1:50186 / *:3081）对外部无凭据请求一律 401，
 * 外部进程拿不到 GUI 客户端的凭据。所以这里自己用 `node:http` 起一个只绑 loopback 的
 * 监听，配一枚随机 Bearer token（0600 落盘），与 GUI 的鉴权彻底分开。
 *
 * 三条刻意的约束（别顺手改回去）：
 *   1. **零第三方 import**：第三方 Host 插件解析不到 `@deepseek-ai/*` 运行时包。
 *      宿主的服务一律 `ctx.get()` 惰性取；本文件只用 `node:*` 内建模块。
 *   2. **失败必须可见**：服务取不到、token 文件写不了、端口被占，都要在日志与
 *      HTTP 错误信封里说清楚，绝不静默换端口或降级成「看起来能用」。
 *   3. **日志不落内容**：只记路由、会话 id、耗时、结果码；消息正文一律不写。
 *
 * 接口、挂载步骤、回滚、以及「怎么指定模型 / 怎么读状态」两件事的结论，见 README.md。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const name = 'dsh-external-bridge';

/** 桥的监听地址与端口：只绑 loopback，端口固定（被占就失败，不换端口）。 */
export const BRIDGE_HOST = '127.0.0.1';
export const BRIDGE_PORT = 39217;

/** `wait` 长轮询的默认与上限（上限压在 Node 默认 requestTimeout 300s 以内）。 */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MAX_WAIT_TIMEOUT_MS = 240_000;

/** 请求体与消息长度上限：超了明确拒绝，不悄悄截断。 */
export const MAX_BODY_BYTES = 1_048_576;
export const MAX_MESSAGE_CHARS = 200_000;

/** token 文件名；目录与权限见 `tokenPath()`。 */
export const TOKEN_FILENAME = 'external-bridge.token';

/**
 * 预设别名：宿主 `session_create` 工具的说明文字把学习模式写成 `studymate`，
 * 但注册表里的真实 id 是 `learning`（`@yunmiao/studymate` 注册两条：learning / qa）。
 * 这里只做**显式**的别名映射，且仅当注册表里没有同名 id 时生效；其它 id 原样传。
 * 读 README「两个问题的结论」一节。
 */
export const PRESET_ALIASES = Object.freeze({ studymate: 'learning' });

/** 插件自身版本号（/health 用；读 package.json，读不到就 null）。 */
export const VERSION = (() => {
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
})();

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** `$DSH_HOME/secrets/external-bridge.token`（DSH_HOME 缺省 `~/.dsh`）。 */
export function tokenPath(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'secrets', TOKEN_FILENAME);
}

/** 失败信封：`{ ok: false, error: { code, message } }`，可选附加字段（如 sessionId）。 */
export function errorBody(code, message, extra) {
  const error = { code: String(code), message: String(message) };
  return { ok: false, error, ...(extra === undefined ? {} : extra) };
}

/** 从 `Authorization` 头里取 Bearer token；取不到返回 null。 */
export function bearerToken(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(headerValue);
  return match === null ? null : match[1];
}

/** 常量时间比较，避免 token 逐字节泄露时序。 */
export function isAuthorized(headerValue, expectedToken) {
  if (typeof expectedToken !== 'string' || expectedToken === '') return false;
  const provided = bearerToken(headerValue);
  if (provided === null) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 生成一枚新 token（base64url，32 字节熵）。 */
export function mintToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * 落盘 token（目录 0700、文件 0600，先写临时文件再 rename，避免半截文件）。
 * @returns {{ token: string, file: string }}
 * @throws 目录/文件写不了时抛错（调用方负责在日志与接口里说清楚）
 */
export function writeTokenFile(file, token = mintToken()) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const temporary = path.join(dir, `.${TOKEN_FILENAME}.${process.pid.toString(36)}`);
  try {
    fs.writeFileSync(temporary, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* 清理失败不影响已 rename 的结果 */
    }
  }
  fs.chmodSync(file, 0o600);
  return { token, file };
}

/** 把请求体读成 UTF-8 文本；超过上限立刻拒绝，不无限吃内存。 */
export function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // 不 destroy：把剩余字节排掉（丢内容），让客户端能正常收到 413，而不是 EPIPE。
        request.resume();
        finish({ ok: false, code: 'body-too-large', message: `请求体超过 ${limit} 字节上限` });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    request.on('error', (error) => finish({ ok: false, code: 'body-read-failed', message: String(error instanceof Error ? error.message : error) }));
  });
}

/** 解析成 JSON 对象；不是 JSON、不是对象、是数组都拒绝（返回 code/message）。 */
export function parseJsonObject(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, code: 'body-invalid', message: '请求体必须是 JSON 对象（不能为空）' };
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, code: 'body-invalid', message: `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'body-invalid', message: '请求体必须是 JSON 对象' };
  }
  return { ok: true, value };
}

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

/**
 * 方法 + 路径 → 路由描述。路径存在但方法不对返回 `method-not-allowed`，
 * 完全不认得返回 null。
 */
export function matchRoute(method, pathname) {
  const verb = typeof method === 'string' ? method.toUpperCase() : 'GET';
  const route = (kind, sessionId) => ({ kind, ...(sessionId === undefined ? {} : { sessionId }) });

  if (pathname === '/health') return verb === 'GET' ? route('health') : { kind: 'method-not-allowed', allow: 'GET' };
  if (pathname === '/sessions') {
    if (verb === 'GET') return route('list-sessions');
    if (verb === 'POST') return route('create-session');
    return { kind: 'method-not-allowed', allow: 'GET, POST' };
  }
  const match = /^\/sessions\/([^/]+)(?:\/(prompt|wait))?$/.exec(pathname);
  if (match !== null) {
    let sessionId;
    try {
      sessionId = decodeURIComponent(match[1]);
    } catch {
      return { kind: 'bad-request', message: 'sessionId 不是合法的 URL 编码' };
    }
    if (sessionId.trim() === '') return { kind: 'bad-request', message: 'sessionId 不能为空' };
    const tail = match[2];
    if (tail === 'prompt') return verb === 'POST' ? route('prompt', sessionId) : { kind: 'method-not-allowed', allow: 'POST' };
    if (tail === 'wait') return verb === 'GET' ? route('wait', sessionId) : { kind: 'method-not-allowed', allow: 'GET' };
    return verb === 'GET' ? route('state', sessionId) : { kind: 'method-not-allowed', allow: 'GET' };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 参数校验
 * ------------------------------------------------------------------ */

function fail(code, message) {
  return { ok: false, code, message };
}

/** `POST /sessions` 的入参校验。 */
export function validateCreateBody(body) {
  if (!isPlainObject(body)) return fail('body-invalid', '请求体必须是 JSON 对象');
  const hasCwd = body.cwd !== undefined && body.cwd !== null;
  const hasWorkspace = body.workspaceId !== undefined && body.workspaceId !== null;
  if (hasCwd && hasWorkspace) return fail('bad-request', 'cwd 与 workspaceId 只能给一个');
  if (!hasCwd && !hasWorkspace) return fail('bad-request', '必须给 cwd 或 workspaceId（当前工作区列表见 GET /sessions）');
  if (hasWorkspace && (typeof body.workspaceId !== 'string' || body.workspaceId.trim() === '')) {
    return fail('bad-request', 'workspaceId 必须是非空字符串');
  }
  if (hasCwd) {
    if (typeof body.cwd !== 'string' || body.cwd.trim() === '') return fail('bad-request', 'cwd 必须是非空字符串');
    if (!path.isAbsolute(body.cwd)) return fail('bad-request', `cwd 必须是绝对路径（收到 ${body.cwd}）`);
  }
  if (body.agentPreset !== undefined && body.agentPreset !== null) {
    if (typeof body.agentPreset !== 'string' || body.agentPreset.trim() === '') return fail('bad-request', 'agentPreset 必须是非空字符串');
  }
  const hasProvider = body.provider !== undefined && body.provider !== null;
  const hasModel = body.model !== undefined && body.model !== null;
  if (hasProvider !== hasModel) return fail('bad-request', 'provider 与 model 必须同时给');
  if (hasProvider && (typeof body.provider !== 'string' || body.provider.trim() === '')) return fail('bad-request', 'provider 必须是非空字符串');
  if (hasModel && (typeof body.model !== 'string' || body.model.trim() === '')) return fail('bad-request', 'model 必须是非空字符串');
  if (body.reasoningEffort !== undefined && body.reasoningEffort !== null) {
    if (!hasProvider) return fail('bad-request', 'reasoningEffort 只有同时给了 provider + model 才有意义');
    if (typeof body.reasoningEffort !== 'string' || body.reasoningEffort.trim() === '') {
      return fail('bad-request', 'reasoningEffort 必须是非空字符串（如 off / low / high / max）');
    }
  }
  if (body.firstPrompt !== undefined && body.firstPrompt !== null && typeof body.firstPrompt !== 'string') {
    return fail('bad-request', 'firstPrompt 必须是字符串');
  }
  return {
    ok: true,
    value: {
      ...(hasCwd ? { cwd: body.cwd.trim() } : {}),
      ...(hasWorkspace ? { workspaceId: body.workspaceId.trim() } : {}),
      ...(typeof body.agentPreset === 'string' ? { agentPreset: body.agentPreset.trim() } : {}),
      ...(typeof body.provider === 'string' ? { provider: body.provider.trim(), model: body.model.trim() } : {}),
      ...(typeof body.reasoningEffort === 'string' ? { reasoningEffort: body.reasoningEffort.trim() } : {}),
      ...(typeof body.firstPrompt === 'string' && body.firstPrompt.trim() !== '' ? { firstPrompt: body.firstPrompt } : {}),
    },
  };
}

/** `POST /sessions/:id/prompt` 的入参校验。 */
export function validatePromptBody(body) {
  if (!isPlainObject(body)) return fail('body-invalid', '请求体必须是 JSON 对象');
  if (typeof body.message !== 'string' || body.message.trim() === '') return fail('bad-request', 'message 必须是非空字符串');
  if (body.message.length > MAX_MESSAGE_CHARS) return fail('bad-request', `message 超过 ${MAX_MESSAGE_CHARS} 字符上限`);
  const mode = body.mode === undefined || body.mode === null ? 'queue' : body.mode;
  if (mode !== 'queue' && mode !== 'steer') return fail('bad-request', 'mode 只能是 queue 或 steer');
  return { ok: true, value: { message: body.message, mode } };
}

/** `?timeoutMs=` 的校验：正整数，不超过上限。 */
export function parseTimeoutMs(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: DEFAULT_WAIT_TIMEOUT_MS };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return fail('bad-request', 'timeoutMs 必须是正整数');
  if (value > MAX_WAIT_TIMEOUT_MS) return fail('bad-request', `timeoutMs 不能超过 ${MAX_WAIT_TIMEOUT_MS}`);
  return { ok: true, value };
}

/**
 * 预设 id 解析：注册表里有同名 id 就原样用；没有才查显式别名表。
 * @returns 解析后的 id，或 null（调用方报错并附上可用 id 列表）
 */
export function resolvePresetId(requested, availableIds) {
  const wanted = textOf(requested).trim();
  if (wanted === '') return null;
  const ids = Array.isArray(availableIds) ? availableIds : [];
  if (ids.includes(wanted)) return wanted;
  const aliased = PRESET_ALIASES[wanted];
  if (aliased !== undefined && ids.includes(aliased)) return aliased;
  return null;
}

/** 模型目录摊平成 `provider/model` 列表；目录拿不到返回 null（不编）。 */
export function flattenModelCatalog(catalog) {
  if (!isPlainObject(catalog) || !Array.isArray(catalog.groups)) return null;
  const models = [];
  for (const group of catalog.groups) {
    if (!isPlainObject(group) || typeof group.id !== 'string' || !Array.isArray(group.models)) continue;
    for (const model of group.models) {
      if (!isPlainObject(model) || typeof model.id !== 'string') continue;
      models.push(`${group.id}/${model.id}`);
    }
  }
  return models;
}

/* ------------------------------------------------------------------ *
 * 会话事件读取（状态 / 最后一条助手回复）
 * ------------------------------------------------------------------ */

function assistantTextOf(event) {
  if (!isPlainObject(event) || event.type !== 'assistant/message') return '';
  const message = isPlainObject(event.data) ? event.data.message : undefined;
  const content = isPlainObject(message) && Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (!isPlainObject(block) || block.type !== 'text') continue;
    if (typeof block.text === 'string' && block.text !== '') parts.push(block.text);
  }
  return parts.join('').trim();
}

/**
 * 从完整事件表里汇总状态字段：
 *   · lastAssistantText：最后一条**带正文**的 assistant/message（工具调用行不算回复）；
 *   · turnCount：已完成的回合数（`turn/end` 计数；进行中的回合不计）；
 *   · error：最后一个回合以 `reason.kind === "error"` 结束时给出 code/message。
 * @returns {{ lastAssistantText: string, turnCount: number, error: null | { code: string, message: string } }}
 */
export function summarizeEvents(events) {
  let lastAssistantText = '';
  let turnCount = 0;
  let error = null;
  if (Array.isArray(events)) {
    for (const event of events) {
      if (!isPlainObject(event)) continue;
      if (event.type === 'turn/end') {
        turnCount += 1;
        const reason = isPlainObject(event.data) ? event.data.reason : undefined;
        if (isPlainObject(reason) && reason.kind === 'error') {
          const detail = isPlainObject(reason.error) ? reason.error : {};
          error = {
            code: typeof detail.code === 'string' ? detail.code : 'turn-error',
            message: typeof detail.message === 'string' ? detail.message : '回合执行失败',
          };
        }
      }
      if (event.type === 'assistant/message') {
        const text = assistantTextOf(event);
        if (text !== '') lastAssistantText = text;
      }
    }
  }
  return { lastAssistantText, turnCount, error };
}

/** 最后一条助手回复：从 controller.wait / events 的 records（newest-first）里挑第一条带正文的。 */
export function latestAssistantTextFromRecords(records) {
  if (!Array.isArray(records)) return '';
  for (const record of records) {
    if (!isPlainObject(record) || record.type !== 'event') continue;
    const text = assistantTextOf(record.event);
    if (text !== '') return text;
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * 宿主服务访问
 * ------------------------------------------------------------------ */

class BridgeError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.extra = extra;
  }
}

function serviceOf(ctx, serviceName) {
  try {
    const value = ctx?.get?.(serviceName);
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

function requireService(ctx, serviceName) {
  const value = serviceOf(ctx, serviceName);
  if (value === null || value === undefined) {
    throw new BridgeError('service-unavailable', `宿主服务 "${serviceName}" 当前不可用：这个部署没有挂载它，或还没就绪`);
  }
  return value;
}

/** 稳定的「未知会话」判定：不同层可能抛 RemoteError 或 SessionQueryError。 */
function isSessionNotFound(error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
  return code === 'session/not-found' || code === 'SESSION_QUERY_SESSION_NOT_FOUND';
}

/**
 * 读一个会话的完整事件表。优先 `sessionQuery.observeSession`（冷/热都读、不激活会话），
 * 退到 `sessions` 存储里的活会话。两边都没有就抛 service-unavailable（不编状态）。
 */
async function readSessionEvents(ctx, sessionId, signal) {
  const query = serviceOf(ctx, 'sessionQuery');
  if (query !== null && typeof query.observeSession === 'function') {
    let observation;
    try {
      observation = await query.observeSession(sessionId, { signal, projectionMode: 'none' });
    } catch (error) {
      if (isSessionNotFound(error)) throw new BridgeError('session/not-found', `会话 "${sessionId}" 不存在`, { sessionId });
      throw error;
    }
    try {
      return Array.isArray(observation.events) ? observation.events : [];
    } finally {
      try {
        observation[Symbol.dispose]?.();
      } catch {
        /* 释放失败不影响读数 */
      }
    }
  }
  const sessions = serviceOf(ctx, 'sessions');
  const live = sessions !== null && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;
  if (live === undefined || live === null) {
    throw new BridgeError('service-unavailable', '宿主既没有 sessionQuery 也没有活的 sessions 存储，读不到会话状态');
  }
  if (typeof live.snapshotEvents !== 'function') {
    throw new BridgeError('service-unavailable', '宿主 Session 对象没有 snapshotEvents()，读不到会话事件');
  }
  return live.snapshotEvents();
}

/**
 * 一个会话的完整状态摘要。`state` 直接问 `sessionController.state`（宿主权威口径），
 * 事件表用于最后回复 / 回合数 / 错误。
 */
async function readSessionSummary(ctx, sessionId, signal) {
  const controller = requireService(ctx, 'sessionController');
  if (typeof controller.state !== 'function') throw new BridgeError('service-unavailable', 'sessionController 没有 state() 方法，当前宿主版本不匹配');
  let stateValue;
  try {
    stateValue = await controller.state({ sessionId }, signal);
  } catch (error) {
    if (isSessionNotFound(error)) throw new BridgeError('session/not-found', `会话 "${sessionId}" 不存在`, { sessionId });
    throw error;
  }
  let events = null;
  let eventsError = null;
  try {
    events = await readSessionEvents(ctx, sessionId, signal);
  } catch (error) {
    eventsError = error instanceof Error ? error.message : String(error);
  }
  const summary = summarizeEvents(events);
  const running = stateValue !== null && typeof stateValue === 'object' && stateValue.running === true;
  const state = running ? 'running' : summary.error !== null ? 'error' : 'idle';
  return {
    sessionId,
    state,
    lastAssistantText: summary.lastAssistantText,
    turnCount: events === null ? null : summary.turnCount,
    ...(summary.error === null ? {} : { error: summary.error }),
    ...(eventsError === null ? {} : { warning: `读不到会话事件：${eventsError}` }),
  };
}

/** 把一条工作区实体整理成稳定 JSON（不含 getter 魔法）。 */
function workspaceView(entity) {
  const id = entity?.id;
  const title = entity?.title;
  const workspacePath = entity?.path;
  let sessionIds = [];
  try {
    sessionIds = Array.isArray(entity?.sessionIds) ? [...entity.sessionIds] : [];
  } catch {
    sessionIds = [];
  }
  return {
    id: typeof id === 'string' ? id : null,
    title: typeof title === 'string' ? title : null,
    path: typeof workspacePath === 'string' ? workspacePath : null,
    sessionIds,
  };
}

function normalizeComparablePath(value) {
  const trimmed = value.replace(/[/\\]+$/, '');
  try {
    return fs.realpathSync.native(trimmed);
  } catch {
    return trimmed;
  }
}

/** 按目录找已注册工作区（优先 canonical path，退化到字符串比较；darwin 大小写不敏感）。 */
function workspaceForCwd(registry, cwd) {
  if (registry === null || typeof registry.list !== 'function') return null;
  let list;
  try {
    list = registry.list();
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const wanted = normalizeComparablePath(path.resolve(cwd));
  for (const entity of list) {
    const entityPath = typeof entity?.path === 'string' ? entity.path : '';
    if (entityPath === '') continue;
    const candidate = normalizeComparablePath(entityPath);
    if (candidate === wanted) return entity;
    if (process.platform === 'darwin' && candidate.toLowerCase() === wanted.toLowerCase()) return entity;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 处理器
 * ------------------------------------------------------------------ */

function statusForCode(code) {
  if (code === 'unauthorized') return 401;
  if (code === 'body-too-large') return 413;
  if (code === 'body-invalid' || code === 'bad-request') return 400;
  if (code === 'not-found') return 404;
  if (code === 'method-not-allowed') return 405;
  if (code === 'service-unavailable' || code === 'token-unavailable') return 503;
  if (typeof code === 'string') {
    if (code === 'session/not-found' || code === 'workspace/not-found') return 404;
    if (code.startsWith('gateway/bad-request') || code.startsWith('session/model-unavailable')
      || code === 'agent-preset/not-found' || code.startsWith('session/invalid')) return 400;
  }
  return 500;
}

function codeOf(error) {
  if (error instanceof BridgeError) return error.code;
  if (error !== null && typeof error === 'object' && typeof error.code === 'string' && error.code !== '') return error.code;
  return 'internal';
}

function messageOf(error) {
  if (error instanceof Error && typeof error.message === 'string') return error.message;
  return String(error);
}

function sendJson(response, status, payload) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (error) {
    body = JSON.stringify(errorBody('internal', `响应序列化失败：${messageOf(error)}`));
    status = 500;
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function createRequestHandler(options) {
  const { ctx, getToken, getTokenError, log, signal: _signal } = options;

  const emit = (level, message) => {
    if (typeof log === 'function') log(level, message);
  };

  return async function handle(request, response) {
    const startedAt = Date.now();
    const method = typeof request.method === 'string' ? request.method : 'GET';
    let routeLabel = 'unknown';
    let sessionLabel = '-';
    let status = 500;
    let codeLabel = 'internal';

    // 客户端断开时中止我们这边的读取（长轮询尤其重要）
    const abort = new AbortController();
    const onClose = () => abort.abort();
    response.on('close', onClose);

    try {
      const url = new URL(request.url ?? '/', `http://${BRIDGE_HOST}`);
      const route = matchRoute(method, url.pathname);
      if (route === null) {
        status = 404;
        codeLabel = 'not-found';
        sendJson(response, 404, errorBody('not-found', `没有这个路由：${method} ${url.pathname}`));
        return;
      }
      routeLabel = route.kind;
      if (route.kind === 'method-not-allowed') {
        status = 405;
        codeLabel = 'method-not-allowed';
        sendJson(response, 405, errorBody('method-not-allowed', `${url.pathname} 只接受 ${route.allow}；收到 ${method}`));
        return;
      }
      if (route.kind === 'bad-request') {
        status = 400;
        codeLabel = 'bad-request';
        sendJson(response, 400, errorBody('bad-request', route.message));
        return;
      }
      if (route.sessionId !== undefined) sessionLabel = route.sessionId;

      // 鉴权：token 生成失败时先说清楚，再拒绝
      const tokenError = typeof getTokenError === 'function' ? getTokenError() : null;
      if (tokenError !== null) {
        status = 503;
        codeLabel = 'token-unavailable';
        sendJson(response, 503, errorBody('token-unavailable', tokenError));
        return;
      }
      const token = typeof getToken === 'function' ? getToken() : null;
      if (!isAuthorized(request.headers.authorization, token)) {
        status = 401;
        codeLabel = 'unauthorized';
        sendJson(response, 401, errorBody('unauthorized', '缺少或错误的 Authorization: Bearer <token>；token 见 ~/.dsh/secrets/external-bridge.token'));
        return;
      }

      const signal = abort.signal;

      if (route.kind === 'health') {
        const payload = await healthPayload(ctx);
        status = 200;
        codeLabel = 'ok';
        sendJson(response, 200, payload);
        return;
      }

      if (route.kind === 'list-sessions') {
        const registry = serviceOf(ctx, 'workspaceRegistry');
        if (registry === null || typeof registry.list !== 'function') {
          throw new BridgeError('service-unavailable', '宿主没有可用的 workspaceRegistry，列不了工作区');
        }
        const workspaces = (registry.list() ?? []).map(workspaceView);
        status = 200;
        codeLabel = 'ok';
        sendJson(response, 200, { ok: true, workspaces });
        return;
      }

      if (route.kind === 'create-session') {
        const raw = await readBody(request);
        if (!raw.ok) throw new BridgeError(raw.code, raw.message);
        const parsed = parseJsonObject(raw.text);
        if (!parsed.ok) throw new BridgeError(parsed.code, parsed.message);
        const validated = validateCreateBody(parsed.value);
        if (!validated.ok) throw new BridgeError(validated.code, validated.message);
        const payload = await createSession(ctx, validated.value, signal);
        status = 200;
        codeLabel = 'ok';
        sendJson(response, 200, payload);
        return;
      }

      if (route.kind === 'prompt') {
        const raw = await readBody(request);
        if (!raw.ok) throw new BridgeError(raw.code, raw.message);
        const parsed = parseJsonObject(raw.text);
        if (!parsed.ok) throw new BridgeError(parsed.code, parsed.message);
        const validated = validatePromptBody(parsed.value);
        if (!validated.ok) throw new BridgeError(validated.code, validated.message);
        const payload = await promptSession(ctx, route.sessionId, validated.value, signal);
        status = 200;
        codeLabel = 'ok';
        sendJson(response, 200, payload);
        return;
      }

      if (route.kind === 'state') {
        const summary = await readSessionSummary(ctx, route.sessionId, signal);
        status = 200;
        codeLabel = 'ok';
        sendJson(response, 200, { ok: true, ...summary });
        return;
      }

      if (route.kind === 'wait') {
        const timeout = parseTimeoutMs(url.searchParams.get('timeoutMs'));
        if (!timeout.ok) throw new BridgeError(timeout.code, timeout.message);
        const payload = await waitSession(ctx, route.sessionId, timeout.value, signal);
        status = 200;
        codeLabel = 'ok';
        sendJson(response, 200, payload);
        return;
      }

      throw new BridgeError('internal', `路由 ${route.kind} 没有实现`);
    } catch (error) {
      const code = codeOf(error);
      status = statusForCode(code);
      codeLabel = code;
      const extra = error instanceof BridgeError ? error.extra : undefined;
      sendJson(response, status, errorBody(code, messageOf(error), extra));
    } finally {
      response.off('close', onClose);
      const duration = Date.now() - startedAt;
      emit('info', `route=${routeLabel} method=${method} status=${status} code=${codeLabel} session=${sessionLabel} ms=${duration}`);
    }
  };
}

/* ------------------------------------------------------------------ *
 * 各路由的业务实现
 * ------------------------------------------------------------------ */

async function healthPayload(ctx) {
  const payload = { ok: true, version: VERSION, presets: null, models: null };
  const presets = serviceOf(ctx, 'agentPresets');
  if (presets !== null && typeof presets.list === 'function') {
    try {
      const roster = await presets.list();
      if (Array.isArray(roster)) {
        payload.presets = roster
          .filter((entry) => isPlainObject(entry) && typeof entry.id === 'string' && entry.broken === undefined)
          .map((entry) => entry.id);
      }
    } catch {
      payload.presets = null;
    }
  }
  const controller = serviceOf(ctx, 'sessionController');
  if (controller !== null && typeof controller.modelCatalog === 'function') {
    try {
      payload.models = flattenModelCatalog(await controller.modelCatalog());
    } catch {
      payload.models = null;
    }
  }
  return payload;
}

function mintRequestId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function promptContent(message) {
  return [{ type: 'text', text: message }];
}

async function resolvePresetForCreate(ctx, requested) {
  if (requested === undefined) return null;
  const presets = serviceOf(ctx, 'agentPresets');
  let ids = null;
  if (presets !== null && typeof presets.list === 'function') {
    try {
      const roster = await presets.list();
      if (Array.isArray(roster)) ids = roster.filter((entry) => isPlainObject(entry) && entry.broken === undefined && typeof entry.id === 'string').map((entry) => entry.id);
    } catch {
      ids = null;
    }
  }
  if (ids === null) {
    // 注册表读不到：原样传下去，让宿主的 create 自己报错（不猜测、不静默改写）
    return requested;
  }
  const resolved = resolvePresetId(requested, ids);
  if (resolved === null) {
    throw new BridgeError('agent-preset/not-found', `没有这个 agent preset：「${requested}」。可用：${ids.join('、') || '（空）'}`, { requested, available: ids });
  }
  return resolved;
}

async function createSession(ctx, input, signal) {
  const controller = requireService(ctx, 'sessionController');
  if (typeof controller.create !== 'function') throw new BridgeError('service-unavailable', 'sessionController 没有 create() 方法，当前宿主版本不匹配');

  const request = {};
  let warning = null;
  if (input.workspaceId !== undefined) {
    request.workspaceId = input.workspaceId;
  } else {
    const registry = serviceOf(ctx, 'workspaceRegistry');
    const workspace = workspaceForCwd(registry, input.cwd);
    if (workspace !== null) {
      // 显式按工作区建：宿主会 attachSession，侧栏里必定出现。
      request.workspaceId = workspace.id;
    } else {
      // 目录不属于任何已注册工作区：仍按 cwd 建（会话存在），但 GUI 侧栏可能不显示。
      request.cwd = input.cwd;
      warning = `cwd「${input.cwd}」不属于任何已注册工作区（GET /sessions 可看列表）；会话能建但 GUI 侧栏可能不显示。要出现在侧栏，先给它建一个工作区，或用 workspaceId。`;
    }
  }

  const preset = await resolvePresetForCreate(ctx, input.agentPreset);
  if (preset !== null) request.agentPreset = preset;

  let created;
  try {
    created = await controller.create(request);
  } catch (error) {
    if (isSessionNotFound(error)) throw new BridgeError('workspace/not-found', messageOf(error), { workspaceId: request.workspaceId });
    throw error;
  }
  if (!isPlainObject(created) || typeof created.sessionId !== 'string' || created.sessionId === '') {
    throw new BridgeError('internal', `sessionController.create 没有返回 sessionId（收到 ${JSON.stringify(created)}）`);
  }
  const sessionId = created.sessionId;

  const payload = {
    ok: true,
    sessionId,
    ...(typeof created.agentPreset === 'string' ? { agentPreset: created.agentPreset } : {}),
    ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
    ...(warning === null ? {} : { warning }),
  };

  // 模型：create 不接受模型字段；GUI 用的是 selectModel（见 README「两个问题的结论」）
  if (input.provider !== undefined) {
    try {
      const selected = await applyModelSelection(ctx, controller, sessionId, input);
      payload.model = selected;
    } catch (error) {
      const code = codeOf(error);
      // 会话已经建出来了：把 id 带回去，调用方可以自己接上继续用
      throw new BridgeError(code === 'internal' ? 'session/model-unavailable' : code, messageOf(error), { sessionId });
    }
  }

  if (input.firstPrompt !== undefined) {
    try {
      const receipt = await controller.prompt({
        requestId: mintRequestId('bridge-create'),
        sessionId,
        mode: 'queue',
        content: promptContent(input.firstPrompt),
      }, signal);
      payload.firstPrompt = receipt;
    } catch (error) {
      throw new BridgeError(codeOf(error), messageOf(error), { sessionId });
    }
  }

  return payload;
}

/**
 * 给会话指定模型。`sessionController.selectModel` 是 GUI 模型菜单走的同一个 RPC
 * （`dsh-client-ui-model-selection` 里 `this.sessions.selectModel(...)`）。
 * 它会**顺带把这次选择存成默认模型**（宿主行为）；这里在成功之后把原默认值写回去，
 * 避免外部调用悄悄改掉用户 GUI 的默认模型。
 */
async function applyModelSelection(ctx, controller, sessionId, input) {
  const selection = {
    provider: input.provider,
    model: input.model,
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
  };
  const defaults = serviceOf(ctx, 'agentDefaultModel');
  let previous = null;
  try {
    previous = defaults !== null && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : null;
  } catch {
    previous = null;
  }
  const result = await controller.selectModel({ sessionId, ...selection }, new AbortController().signal);
  if (previous !== null && typeof defaults?.saveSelection === 'function') {
    const same = previous.provider === selection.provider && previous.model === selection.model
      && (previous.reasoningEffort ?? undefined) === (selection.reasoningEffort ?? undefined);
    if (!same) {
      try {
        await defaults.saveSelection(previous);
      } catch {
        // 恢复默认失败不影响本次会话的模型选择；README 里写明可能的残留
      }
    }
  }
  return isPlainObject(result) && isPlainObject(result.selected) ? result.selected : selection;
}

async function promptSession(ctx, sessionId, input, signal) {
  const controller = requireService(ctx, 'sessionController');
  if (typeof controller.prompt !== 'function') throw new BridgeError('service-unavailable', 'sessionController 没有 prompt() 方法，当前宿主版本不匹配');
  const requestId = mintRequestId('bridge-prompt');
  try {
    const receipt = await controller.prompt({
      requestId,
      sessionId,
      mode: input.mode,
      content: promptContent(input.message),
    }, signal);
    return { ok: true, sessionId, requestId, mode: input.mode, receipt };
  } catch (error) {
    if (isSessionNotFound(error)) throw new BridgeError('session/not-found', `会话 "${sessionId}" 不存在`, { sessionId });
    throw error;
  }
}

async function waitSession(ctx, sessionId, timeoutMs, signal) {
  const controller = requireService(ctx, 'sessionController');
  if (typeof controller.wait !== 'function') throw new BridgeError('service-unavailable', 'sessionController 没有 wait() 方法，当前宿主版本不匹配');
  let result;
  try {
    result = await controller.wait({ sessionId, timeoutMs, afterSeq: -1, maxMessages: 20 }, signal);
  } catch (error) {
    const code = codeOf(error);
    if (code === 'session/wait-timeout') {
      return { ok: true, sessionId, state: 'running', timedOut: true, timeoutMs };
    }
    if (isSessionNotFound(error)) throw new BridgeError('session/not-found', `会话 "${sessionId}" 不存在`, { sessionId });
    throw error;
  }
  const text = latestAssistantTextFromRecords(isPlainObject(result) && isPlainObject(result.output) ? result.output.records : []);
  let summary = null;
  let warning = null;
  try {
    summary = summarizeEvents(await readSessionEvents(ctx, sessionId, signal));
  } catch (error) {
    warning = `读不到会话事件（turnCount 为 null）：${messageOf(error)}`;
  }
  const stateValue = isPlainObject(result) && isPlainObject(result.state) ? result.state : {};
  const running = stateValue.running === true;
  // 与 GET /sessions/:id 同一口径：运行 > 出错 > 空闲；最后回复优先取 wait 窗口里的，空则退回全量事件摘要
  const state = running ? 'running' : summary !== null && summary.error !== null ? 'error' : 'idle';
  const lastAssistantText = text !== '' ? text : summary === null ? '' : summary.lastAssistantText;
  return {
    ok: true,
    sessionId,
    state,
    lastAssistantText,
    turnCount: summary === null ? null : summary.turnCount,
    ...(summary !== null && summary.error !== null ? { error: summary.error } : {}),
    ...(warning === null ? {} : { warning }),
  };
}

/* ------------------------------------------------------------------ *
 * HTTP server
 * ------------------------------------------------------------------ */

function defaultLogger(level, message) {
  const line = `[dsh-external-bridge] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * 起桥。返回后端点已经在监听；监听失败时 reject（消息里带 errno），
 * 由调用方决定怎么大声报出来。
 */
export async function startBridge(options) {
  const { ctx } = options;
  const host = typeof options.host === 'string' ? options.host : BRIDGE_HOST;
  const port = Number.isSafeInteger(options.port) ? options.port : BRIDGE_PORT;
  const log = typeof options.log === 'function' ? options.log : defaultLogger;
  const file = typeof options.tokenPath === 'string' ? options.tokenPath : tokenPath(options.env ?? process.env);

  let token = null;
  let tokenError = null;
  try {
    const written = writeTokenFile(file, options.token ?? mintToken());
    token = written.token;
  } catch (error) {
    tokenError = `token 文件写不了（${file}）：${messageOf(error)}`;
    log('error', tokenError);
  }

  const server = http.createServer(createRequestHandler({
    ctx,
    getToken: () => token,
    getTokenError: () => tokenError,
    log,
  }));
  const listenOptions = { host, port, exclusive: true };

  const started = await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(new BridgeError('port-unavailable', `无法监听 ${host}:${port}：${messageOf(error)}（端口被占就启动失败，不自动换端口）`));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(listenOptions);
    } catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(new BridgeError('port-unavailable', `无法监听 ${host}:${port}：${messageOf(error)}`));
    }
  });

  let closed = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((resolve) => {
      try {
        server.closeAllConnections?.();
      } catch {
        /* 旧 Node 没有这个 API */
      }
      server.close(() => resolve());
    });
  };

  return {
    server,
    host,
    port: typeof started === 'object' && started !== null ? started.port : port,
    token,
    tokenPath: file,
    tokenError,
    close,
  };
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

function loggerFor(ctx) {
  return (level, message) => {
    try {
      const logger = ctx?.logger;
      const method = logger?.[level];
      if (typeof method === 'function') {
        method.call(logger, message);
        return;
      }
    } catch {
      /* 落到 console */
    }
    defaultLogger(level, message);
  };
}

export function apply(ctx) {
  const log = loggerFor(ctx);
  let bridge = null;
  let disposed = false;

  const dispose = () => {
    disposed = true;
    if (bridge !== null) {
      const running = bridge;
      bridge = null;
      Promise.resolve(running.close()).catch((error) => log('warn', `关闭监听时出错：${messageOf(error)}`));
    }
  };

  startBridge({ ctx, log })
    .then((started) => {
      if (disposed) {
        void started.close();
        return;
      }
      bridge = started;
      log('info', `external bridge 已监听 http://${started.host}:${started.port}；token 文件 ${started.tokenPath}`);
      if (started.tokenError !== null) log('error', `external bridge 已监听，但鉴权不可用：${started.tokenError}`);
    })
    .catch((error) => {
      log('error', `external bridge 没有启动：${messageOf(error)}`);
    });

  const effect = typeof ctx.effect === 'function'
    ? ctx.effect(() => () => dispose(), 'dsh-external-bridge: loopback listener')
    : undefined;
  if (effect === undefined && typeof ctx.on === 'function') ctx.on('dispose', dispose);
}
