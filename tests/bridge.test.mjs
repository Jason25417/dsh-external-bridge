/**
 * dsh-external-bridge 的单元 / 集成测试（不依赖宿主）。
 *
 * 运行：
 *   node --test tests/
 *
 * 覆盖面：
 *   · 纯函数：token 解析与比较、JSON 请求体、路由匹配、参数校验、预设别名、
 *     模型目录摊平、事件摘要（最后回复 / 回合数 / 错误）
 *   · 集成：用假 ctx（内存里的 sessionController / workspaceRegistry / agentPresets /
 *     sessionQuery / agentDefaultModel）起一个真的 http.Server（端口 0），用 fetch 打全部路由：
 *     鉴权、建会话（workspaceId / cwd / 别名 / 模型 / firstPrompt）、发消息、状态、长轮询、
 *     列表、错误信封、端口占用、token 写不了、以及「不把消息正文写进日志」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import {
  BRIDGE_HOST,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_MESSAGE_CHARS,
  bearerToken,
  isAuthorized,
  mintToken,
  writeTokenFile,
  readBody,
  parseJsonObject,
  matchRoute,
  validateCreateBody,
  validatePromptBody,
  parseTimeoutMs,
  resolvePresetId,
  flattenModelCatalog,
  summarizeEvents,
  latestAssistantTextFromRecords,
  startBridge,
  tokenPath,
  errorBody,
} from '../index.js';

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-test-'));
}

function assistantEvent(text, seq = 1) {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  };
}

function toolOnlyAssistantEvent(seq = 2) {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'bash' }] } },
  };
}

function turnEnd(kind, error, seq = 3) {
  return { type: 'turn/end', seq, time: 0, data: { turn: 1, reason: { kind, ...(error === undefined ? {} : { error }) } } };
}

/** 一套内存里的宿主服务，所有调用都记账，供断言。 */
function makeHost(options = {}) {
  const calls = { create: [], selectModel: [], prompt: [], wait: [], saves: [] };
  const events = options.events ?? [
    assistantEvent('第一条回复', 1),
    toolOnlyAssistantEvent(2),
    assistantEvent('最后一条回复', 3),
    turnEnd('completed', undefined, 4),
  ];
  const services = {
    sessionController: {
      async create(request) {
        calls.create.push(request);
        if (request.workspaceId === 'ws-missing') {
          const error = new Error('workspace "ws-missing" not found');
          error.code = 'workspace/not-found';
          throw error;
        }
        return { sessionId: 's1', ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) };
      },
      async selectModel(request) {
        calls.selectModel.push(request);
        if (request.model === 'not-a-model') {
          const error = new Error('model is unavailable');
          error.code = 'session/model-unavailable';
          throw error;
        }
        return { selected: { provider: request.provider, model: request.model, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) } };
      },
      async prompt(request) {
        calls.prompt.push(request);
        if (request.sessionId !== 's1') {
          const error = new Error(`session "${request.sessionId}" not found`);
          error.code = 'session/not-found';
          throw error;
        }
        return { accepted: true };
      },
      async state(request) {
        if (request.sessionId !== 's1') {
          const error = new Error(`session "${request.sessionId}" not found`);
          error.code = 'session/not-found';
          throw error;
        }
        return { cursor: 3, active: true, running: options.running === true, queue: [], pendingInput: false };
      },
      async wait(request) {
        calls.wait.push(request);
        if (options.waitMode === 'timeout') {
          const error = new Error('session wait timed out');
          error.code = 'session/wait-timeout';
          throw error;
        }
        if (options.waitMode === 'not-found') {
          const error = new Error('session "s1" not found');
          error.code = 'session/not-found';
          throw error;
        }
        return {
          reason: 'idle',
          state: { cursor: 3, active: true, running: false, queue: [], pendingInput: false },
          output: { records: [{ type: 'event', event: assistantEvent('等到的回复', 5) }], truncated: false },
        };
      },
      async modelCatalog() {
        return {
          default: { provider: 'opencode-go-3', model: 'deepseek-v4.1-flash' },
          groups: [
            { id: 'opencode-go-4', name: 'Go 4', models: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4.1-flash' }] },
            { id: 'deepseek-official', name: 'Official', models: [{ id: 'deepseek-flash' }] },
          ],
        };
      },
      async list() {
        return { items: [] };
      },
    },
    agentPresets: {
      async list() {
        return [
          { id: 'standard', name: 'Standard', order: 1 },
          { id: 'learning', name: '学习模式', order: 10 },
          { id: 'qa', name: '答疑模式', order: 20 },
          { id: 'broken-one', name: 'Broken', order: 30, broken: 'boom' },
        ];
      },
    },
    workspaceRegistry: {
      list() {
        return [
          { id: 'ws1', title: '默认工作区', path: '/tmp/dsh-bridge-ws', sessionIds: ['s1'] },
        ];
      },
      get(id) {
        return id === 'ws1' ? { id: 'ws1', path: '/tmp/dsh-bridge-ws' } : undefined;
      },
    },
    sessionQuery: {
      async observeSession() {
        return { events, cursor: events.length - 1, [Symbol.dispose]() {} };
      },
    },
    sessions: {
      get(id) {
        return id === 's1' ? { snapshotEvents: () => events } : undefined;
      },
    },
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'opencode-go-3', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' };
      },
      async saveSelection(next) {
        calls.saves.push(next);
      },
    },
  };
  const logs = [];
  const ctx = {
    get: (serviceName) => services[serviceName],
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    effect: (fn) => fn(),
    on: () => {},
  };
  return { ctx, services, calls, logs, events };
}

async function withBridge(hostOptions, run) {
  const dir = tempDir();
  const file = path.join(dir, 'secrets', 'external-bridge.token');
  const host = makeHost(hostOptions);
  const bridge = await startBridge({ ctx: host.ctx, port: 0, host: BRIDGE_HOST, tokenPath: file, log: () => {} });
  try {
    await run({ bridge, file, ...host, dir });
  } finally {
    await bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function requestUrl(bridge, pathname) {
  return `http://${BRIDGE_HOST}:${bridge.port}${pathname}`;
}

async function call(bridge, pathname, options = {}) {
  const headers = { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.headers ?? {}) };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? bridge.token}`;
  const response = await fetch(requestUrl(bridge, pathname), {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

test('bearerToken：只认 Bearer 方案', () => {
  assert.equal(bearerToken('Bearer abc'), 'abc');
  assert.equal(bearerToken('bearer abc'), 'abc');
  assert.equal(bearerToken('  Bearer   abc  '), 'abc');
  assert.equal(bearerToken('Token abc'), null);
  assert.equal(bearerToken('Bearer'), null);
  assert.equal(bearerToken(undefined), null);
});

test('isAuthorized：长度不同也不同义，正确 token 才通过', () => {
  assert.equal(isAuthorized('Bearer short', 'a-much-longer-token'), false);
  assert.equal(isAuthorized('Bearer wrong', 'right-token'), false);
  assert.equal(isAuthorized(undefined, 'right-token'), false);
  assert.equal(isAuthorized('Bearer right-token', 'right-token'), true);
  assert.equal(isAuthorized('Bearer right-token', ''), false);
});

test('mintToken：每次不同、长度足够', () => {
  const a = mintToken();
  const b = mintToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40, `token 太短：${a.length}`);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test('writeTokenFile：目录 0700、文件 0600、内容就是 token', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'secrets', 'external-bridge.token');
    const { token } = writeTokenFile(file);
    const stat = fs.statSync(file);
    const dirStat = fs.statSync(path.dirname(file));
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(dirStat.mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), token);
    // 再写一次：换 token、仍然是 0600
    const second = writeTokenFile(file);
    assert.notEqual(second.token, token);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tokenPath：尊重 DSH_HOME', () => {
  assert.equal(tokenPath({ DSH_HOME: '/tmp/x' }), '/tmp/x/secrets/external-bridge.token');
  assert.ok(tokenPath({}).endsWith('/.dsh/secrets/external-bridge.token'));
});

test('parseJsonObject：只收 JSON 对象', () => {
  assert.equal(parseJsonObject('{"a":1}').ok, true);
  assert.equal(parseJsonObject('').ok, false);
  assert.equal(parseJsonObject('{"a":').ok, false);
  assert.equal(parseJsonObject('[]').ok, false);
  assert.equal(parseJsonObject('null').ok, false);
  assert.equal(parseJsonObject('"x"').ok, false);
});

test('matchRoute：全部路由 + 方法不匹配', () => {
  assert.deepEqual(matchRoute('GET', '/health'), { kind: 'health' });
  assert.deepEqual(matchRoute('POST', '/sessions'), { kind: 'create-session' });
  assert.deepEqual(matchRoute('GET', '/sessions'), { kind: 'list-sessions' });
  assert.deepEqual(matchRoute('POST', '/sessions/s1/prompt'), { kind: 'prompt', sessionId: 's1' });
  assert.deepEqual(matchRoute('GET', '/sessions/s1/wait'), { kind: 'wait', sessionId: 's1' });
  assert.deepEqual(matchRoute('GET', '/sessions/s1'), { kind: 'state', sessionId: 's1' });
  assert.deepEqual(matchRoute('POST', '/sessions/s1'), { kind: 'method-not-allowed', allow: 'GET' });
  assert.deepEqual(matchRoute('DELETE', '/sessions'), { kind: 'method-not-allowed', allow: 'GET, POST' });
  assert.equal(matchRoute('GET', '/nope'), null);
  assert.deepEqual(matchRoute('GET', '/sessions/a%20b'), { kind: 'state', sessionId: 'a b' });
});

test('validateCreateBody：cwd / workspaceId 二选一，模型三项配套', () => {
  assert.equal(validateCreateBody({ workspaceId: 'ws1' }).ok, true);
  assert.equal(validateCreateBody({ cwd: '/tmp' }).ok, true);
  assert.equal(validateCreateBody({}).ok, false);
  assert.equal(validateCreateBody({ workspaceId: 'ws1', cwd: '/tmp' }).ok, false);
  assert.equal(validateCreateBody({ cwd: 'relative/path' }).ok, false);
  assert.equal(validateCreateBody({ workspaceId: '' }).ok, false);
  assert.equal(validateCreateBody({ workspaceId: 'ws1', provider: 'p' }).ok, false);
  assert.equal(validateCreateBody({ workspaceId: 'ws1', provider: 'p', model: 'm' }).ok, true);
  assert.equal(validateCreateBody({ workspaceId: 'ws1', reasoningEffort: 'max' }).ok, false);
  assert.equal(validateCreateBody({ workspaceId: 'ws1', provider: 'p', model: 'm', reasoningEffort: 'max' }).ok, true);
  assert.equal(validateCreateBody({ workspaceId: 'ws1', agentPreset: 7 }).ok, false);
  assert.equal(validateCreateBody({ workspaceId: 'ws1', firstPrompt: 7 }).ok, false);
});

test('validatePromptBody：非空 message、mode 只能是 queue/steer', () => {
  assert.equal(validatePromptBody({ message: 'hi' }).ok, true);
  assert.deepEqual(validatePromptBody({ message: 'hi' }).value, { message: 'hi', mode: 'queue' });
  assert.equal(validatePromptBody({ message: '   ' }).ok, false);
  assert.equal(validatePromptBody({}).ok, false);
  assert.equal(validatePromptBody({ message: 'hi', mode: 'now' }).ok, false);
  assert.equal(validatePromptBody({ message: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }).ok, false);
});

test('parseTimeoutMs：默认 30s、拒绝 0/负数/超上限', () => {
  assert.deepEqual(parseTimeoutMs(undefined), { ok: true, value: DEFAULT_WAIT_TIMEOUT_MS });
  assert.equal(parseTimeoutMs('2500').ok, true);
  assert.equal(parseTimeoutMs('0').ok, false);
  assert.equal(parseTimeoutMs('-5').ok, false);
  assert.equal(parseTimeoutMs('abc').ok, false);
  assert.equal(parseTimeoutMs('99999999').ok, false);
});

test('resolvePresetId：同名优先，studymate 别名到 learning，未知不猜', () => {
  assert.equal(resolvePresetId('learning', ['standard', 'learning']), 'learning');
  assert.equal(resolvePresetId('studymate', ['standard', 'learning']), 'learning');
  assert.equal(resolvePresetId('studymate', ['standard']), null);
  assert.equal(resolvePresetId('', ['standard']), null);
  assert.equal(resolvePresetId('nope', ['standard']), null);
});

test('flattenModelCatalog：摊平成 provider/model，异常回 null', () => {
  assert.deepEqual(flattenModelCatalog({ groups: [{ id: 'p', models: [{ id: 'm' }] }] }), ['p/m']);
  assert.deepEqual(flattenModelCatalog({ groups: [] }), []);
  assert.equal(flattenModelCatalog(null), null);
  assert.equal(flattenModelCatalog({}), null);
});

test('summarizeEvents：最后一条有正文的回复 / 回合数 / 错误', () => {
  const events = [
    assistantEvent('一', 1),
    toolOnlyAssistantEvent(2),
    assistantEvent('二', 3),
    turnEnd('completed', undefined, 4),
    turnEnd('error', { code: 'RATE_LIMIT', message: '上游限流' }, 5),
  ];
  const summary = summarizeEvents(events);
  assert.equal(summary.lastAssistantText, '二');
  assert.equal(summary.turnCount, 2);
  assert.deepEqual(summary.error, { code: 'RATE_LIMIT', message: '上游限流' });
});

test('latestAssistantTextFromRecords：newest-first 里取第一条有正文的', () => {
  const records = [
    { type: 'event', event: toolOnlyAssistantEvent(9) },
    { type: 'event', event: assistantEvent('较新', 8) },
    { type: 'event', event: assistantEvent('较旧', 7) },
  ];
  assert.equal(latestAssistantTextFromRecords(records), '较新');
  assert.equal(latestAssistantTextFromRecords([]), '');
});

test('errorBody：稳定信封', () => {
  assert.deepEqual(errorBody('bad-request', 'x'), { ok: false, error: { code: 'bad-request', message: 'x' } });
  assert.deepEqual(errorBody('e', 'm', { sessionId: 's1' }), { ok: false, error: { code: 'e', message: 'm' }, sessionId: 's1' });
});

/* ------------------------------------------------------------------ *
 * 集成：起真 HTTP server + 假 ctx
 * ------------------------------------------------------------------ */

test('鉴权：无 token / 错 token 回 401，正确 token 过', async () => {
  await withBridge({}, async ({ bridge }) => {
    const missing = await call(bridge, '/health', { token: null });
    assert.equal(missing.status, 401);
    assert.equal(missing.json.ok, false);
    assert.equal(missing.json.error.code, 'unauthorized');

    const wrong = await call(bridge, '/health', { token: 'wrong' });
    assert.equal(wrong.status, 401);

    const ok = await call(bridge, '/health');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
  });
});

test('/health：version / presets（跳过 broken）/ models', async () => {
  await withBridge({}, async ({ bridge }) => {
    const { status, json } = await call(bridge, '/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    assert.deepEqual(json.presets, ['standard', 'learning', 'qa']);
    assert.deepEqual(json.models, [
      'opencode-go-4/deepseek-v4-pro',
      'opencode-go-4/deepseek-v4.1-flash',
      'deepseek-official/deepseek-flash',
    ]);
  });
});

test('/health：服务缺失时 presets / models 回 null（不编）', async () => {
  await withBridge({}, async ({ bridge, services }) => {
    delete services.agentPresets;
    delete services.sessionController;
    const { json } = await call(bridge, '/health');
    assert.equal(json.presets, null);
    assert.equal(json.models, null);
  });
});

test('POST /sessions：workspaceId 直通、预设别名 studymate→learning', async () => {
  await withBridge({}, async ({ bridge, calls }) => {
    const { status, json } = await call(bridge, '/sessions', {
      method: 'POST',
      body: { workspaceId: 'ws1', agentPreset: 'studymate', firstPrompt: '只回复两个字：收到' },
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.sessionId, 's1');
    assert.equal(json.agentPreset, 'learning');
    assert.equal(calls.create[0].workspaceId, 'ws1');
    assert.equal(calls.create[0].agentPreset, 'learning');
    assert.equal(calls.prompt[0].content[0].text, '只回复两个字：收到');
  });
});

test('POST /sessions：cwd 命中已注册工作区时改走 workspaceId（保证侧栏可见）', async () => {
  await withBridge({}, async ({ bridge, calls }) => {
    const { status, json } = await call(bridge, '/sessions', { method: 'POST', body: { cwd: '/tmp/dsh-bridge-ws' } });
    assert.equal(status, 200);
    assert.equal(json.workspaceId, 'ws1');
    assert.equal(calls.create[0].workspaceId, 'ws1');
    assert.equal(calls.create[0].cwd, undefined);
  });
});

test('POST /sessions：cwd 不属于任何工作区仍可建，但回 warning', async () => {
  await withBridge({}, async ({ bridge, calls }) => {
    const { status, json } = await call(bridge, '/sessions', { method: 'POST', body: { cwd: '/tmp/unknown-dir' } });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(calls.create[0].cwd, '/tmp/unknown-dir');
    assert.match(json.warning, /不属于任何已注册工作区/);
  });
});

test('POST /sessions：参数错误回 400；未知预设回 400 并列出可用 id', async () => {
  await withBridge({}, async ({ bridge }) => {
    const both = await call(bridge, '/sessions', { method: 'POST', body: { workspaceId: 'ws1', cwd: '/tmp' } });
    assert.equal(both.status, 400);
    assert.equal(both.json.error.code, 'bad-request');

    const preset = await call(bridge, '/sessions', { method: 'POST', body: { workspaceId: 'ws1', agentPreset: 'nope' } });
    assert.equal(preset.status, 400);
    assert.equal(preset.json.error.code, 'agent-preset/not-found');
    assert.match(preset.json.error.message, /learning/);
  });
});

test('POST /sessions：指定模型走 selectModel，并把默认模型恢复回去', async () => {
  await withBridge({}, async ({ bridge, calls }) => {
    const { status, json } = await call(bridge, '/sessions', {
      method: 'POST',
      body: { workspaceId: 'ws1', provider: 'opencode-go-4', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
    });
    assert.equal(status, 200);
    assert.deepEqual(calls.selectModel[0], { sessionId: 's1', provider: 'opencode-go-4', model: 'deepseek-v4-pro', reasoningEffort: 'max' });
    assert.equal(json.model.reasoningEffort, 'max');
    // 原默认（opencode-go-3 / flash / max）被写回去
    assert.deepEqual(calls.saves, [{ provider: 'opencode-go-3', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }]);
  });
});

test('POST /sessions：模型不可用时报错，但把已建出的 sessionId 带回去', async () => {
  await withBridge({}, async ({ bridge }) => {
    const { status, json } = await call(bridge, '/sessions', {
      method: 'POST',
      body: { workspaceId: 'ws1', provider: 'p', model: 'not-a-model' },
    });
    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.equal(json.sessionId, 's1');
    assert.equal(json.error.code, 'session/model-unavailable');
  });
});

test('POST /sessions/:id/prompt：回执 + 空消息 400 + 未知会话 404', async () => {
  await withBridge({}, async ({ bridge, calls }) => {
    const ok = await call(bridge, '/sessions/s1/prompt', { method: 'POST', body: { message: '继续', mode: 'steer' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.mode, 'steer');
    assert.equal(calls.prompt[0].mode, 'steer');

    const empty = await call(bridge, '/sessions/s1/prompt', { method: 'POST', body: { message: '  ' } });
    assert.equal(empty.status, 400);

    const missing = await call(bridge, '/sessions/nope/prompt', { method: 'POST', body: { message: 'hi' } });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'session/not-found');
  });
});

test('GET /sessions/:id：idle + 最后回复 + 回合数', async () => {
  await withBridge({}, async ({ bridge }) => {
    const { status, json } = await call(bridge, '/sessions/s1');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.sessionId, 's1');
    assert.equal(json.state, 'idle');
    assert.equal(json.lastAssistantText, '最后一条回复');
    assert.equal(json.turnCount, 1);
    assert.equal(json.error, undefined);
  });
});

test('GET /sessions/:id：运行中回 running；上一轮报错回 error + error 字段', async () => {
  await withBridge({ running: true }, async ({ bridge }) => {
    const { json } = await call(bridge, '/sessions/s1');
    assert.equal(json.state, 'running');
  });
  await withBridge({
    events: [assistantEvent('一', 1), turnEnd('error', { code: 'RATE_LIMIT', message: '上游限流' }, 2)],
  }, async ({ bridge }) => {
    const { json } = await call(bridge, '/sessions/s1');
    assert.equal(json.state, 'error');
    assert.deepEqual(json.error, { code: 'RATE_LIMIT', message: '上游限流' });
  });
});

test('GET /sessions/:id/wait：成功等回 idle；超时回 running', async () => {
  await withBridge({}, async ({ bridge, calls }) => {
    const { status, json } = await call(bridge, '/sessions/s1/wait?timeoutMs=2500');
    assert.equal(status, 200);
    assert.equal(json.state, 'idle');
    assert.equal(json.lastAssistantText, '等到的回复');
    assert.equal(calls.wait[0].timeoutMs, 2500);
  });
  await withBridge({ waitMode: 'timeout' }, async ({ bridge }) => {
    const { status, json } = await call(bridge, '/sessions/s1/wait');
    assert.equal(status, 200);
    assert.equal(json.state, 'running');
    assert.equal(json.timedOut, true);
  });
});

test('GET /sessions/:id/wait：上一轮报错时回 error（与 GET /sessions/:id 同口径）', async () => {
  await withBridge({
    events: [assistantEvent('一', 1), turnEnd('error', { code: 'RATE_LIMIT', message: '上游限流' }, 2)],
  }, async ({ bridge }) => {
    const { status, json } = await call(bridge, '/sessions/s1/wait');
    assert.equal(status, 200);
    assert.equal(json.state, 'error');
    assert.deepEqual(json.error, { code: 'RATE_LIMIT', message: '上游限流' });
  });
});

test('GET /sessions：列出工作区与会话 id', async () => {
  await withBridge({}, async ({ bridge }) => {
    const { status, json } = await call(bridge, '/sessions');
    assert.equal(status, 200);
    assert.deepEqual(json.workspaces, [{
      id: 'ws1',
      title: '默认工作区',
      path: '/tmp/dsh-bridge-ws',
      sessionIds: ['s1'],
    }]);
  });
});

test('错误信封：未知路由 404、方法不对 405、坏 JSON 400、请求体过大 413', async () => {
  await withBridge({}, async ({ bridge }) => {
    const notFound = await call(bridge, '/nope');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.error.code, 'not-found');

    const wrongMethod = await call(bridge, '/sessions/s1', { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.json.error.code, 'method-not-allowed');

    const badJson = await fetch(requestUrl(bridge, '/sessions'), {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
      body: '{"workspaceId":',
    });
    assert.equal(badJson.status, 400);
    const badJsonBody = await badJson.json();
    assert.equal(badJsonBody.error.code, 'body-invalid');

    const huge = await fetch(requestUrl(bridge, '/sessions'), {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws1', firstPrompt: 'x'.repeat(2 * 1024 * 1024) }),
    });
    assert.equal(huge.status, 413);
  });
});

test('端口被占：startBridge 明确失败，不换端口', async () => {
  const blocker = net.createServer();
  const port = await new Promise((resolve) => blocker.listen(0, BRIDGE_HOST, () => resolve(blocker.address().port)));
  try {
    const ctx = makeHost().ctx;
    const dir = tempDir();
    try {
      await assert.rejects(
        () => startBridge({ ctx, port, host: BRIDGE_HOST, tokenPath: path.join(dir, 'secrets', 'token'), log: () => {} }),
        (error) => {
          assert.equal(error.code, 'port-unavailable');
          assert.match(error.message, new RegExp(String(port)));
          return true;
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    blocker.close();
  }
});

test('token 写不了：监听仍然起来，但所有请求回 503 并说清原因', async () => {
  const dir = tempDir();
  const blockerFile = path.join(dir, 'blocker');
  fs.writeFileSync(blockerFile, 'x');
  const host = makeHost();
  const bridge = await startBridge({
    ctx: host.ctx,
    port: 0,
    host: BRIDGE_HOST,
    tokenPath: path.join(blockerFile, 'nested', 'token'),
    log: () => {},
  });
  try {
    assert.equal(typeof bridge.tokenError, 'string');
    const response = await call(bridge, '/health');
    assert.equal(response.status, 503);
    assert.equal(response.json.error.code, 'token-unavailable');
  } finally {
    await bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('日志只记路由/会话/耗时，不落消息正文', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'secrets', 'token');
  const host = makeHost();
  const logs = [];
  const bridge = await startBridge({
    ctx: host.ctx,
    port: 0,
    host: BRIDGE_HOST,
    tokenPath: file,
    log: (level, message) => logs.push(`${level}:${message}`),
  });
  try {
    await call(bridge, '/sessions', { method: 'POST', body: { workspaceId: 'ws1', firstPrompt: '绝密内容-不要进日志' } });
    await call(bridge, '/sessions/s1/prompt', { method: 'POST', body: { message: '另一段绝密内容' } });
    await call(bridge, '/sessions/s1');
    const joined = logs.join('\n');
    assert.ok(joined.includes('route=create-session'));
    assert.ok(joined.includes('session=s1'));
    assert.ok(!joined.includes('绝密内容'), '消息正文不应出现在日志里');
    assert.ok(!joined.includes('另一段'), '消息正文不应出现在日志里');
  } finally {
    await bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readBody：超过上限回 body-too-large', async () => {
  const { Readable } = await import('node:stream');
  const stream = Readable.from([Buffer.alloc(64), Buffer.alloc(64)]);
  stream.on = stream.on.bind(stream);
  const result = await readBody(stream, 100);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'body-too-large');
});
