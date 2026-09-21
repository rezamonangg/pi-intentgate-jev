// Deterministic checks for the guard policy. No network: global fetch is stubbed.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import intentGuard from "../extensions/intent-guard.ts";

type Decision = { choice: "allow" | "ask" | "block"; confidence: number };

function stubJev(decision?: Decision, fail?: string) {
  const calls: unknown[] & { authorizations?: string[] } = [];
  calls.authorizations = [];
  (globalThis as any).fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    calls.authorizations!.push(init.headers.Authorization);
    if (fail) throw new Error(fail);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "jev-1.13.0",
        answers: { authorization: { type: "choice", ...decision } },
        usage: {},
      }),
    };
  };
  return calls;
}

function makePi() {
  let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
  let keyCommand: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi = {
    on(event: string, fn: any) {
      if (event === "tool_call") handler = fn;
    },
    registerCommand(name: string, command: any) {
      if (name === "intent-jev-key") keyCommand = command.handler;
    },
  };
  return {
    pi,
    call: (event: any, ctx: any) => handler!(event, ctx),
    command: (args: string, ctx: any) => keyCommand!(args, ctx),
    hasHandler: () => Boolean(handler),
    hasCommand: () => Boolean(keyCommand),
  };
}

function makeCtx(opts: { user?: string; model?: string; hasUI?: boolean; confirm?: boolean } = {}) {
  return {
    hasUI: opts.hasUI ?? false,
    model: { provider: (opts.model ?? "deepseek").split("/")[0], id: (opts.model ?? "deepseek/deepseek-flash").split("/")[1] },
    ui: { confirm: async () => opts.confirm ?? false },
    confirmCalls: 0,
    sessionManager: {
      getBranch: () => [
        { type: "message", id: "u1", message: { role: "user", content: opts.user ?? "What solutions would you recommend? Explain only." } },
        { type: "message", id: "a1", message: { role: "assistant", content: "Here are the options. I will implement option 2." } },
      ],
    },
  };
}

function fresh(tools = "write,edit,bash,powershell") {
  process.env.PI_INTENT_GUARD_TOOLS = tools;
  const { pi, call, hasHandler } = makePi();
  intentGuard(pi as any);
  assert.ok(hasHandler(), "extension must register a tool_call handler");
  return call;
}

let testConfigDir: string;

test.beforeEach(async () => {
  testConfigDir = await mkdtemp(join(tmpdir(), "intent-guard-test-"));
  process.env.PI_CODING_AGENT_DIR = testConfigDir;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.PI_INTENT_GUARD_MODELS;
  delete process.env.PI_INTENT_GUARD_CONFIDENCE;
  process.env.TYPESAFE_API_KEY = "test-key";
});

test.afterEach(async () => {
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(testConfigDir, { recursive: true, force: true });
});

test("blocks a guarded tool when the user asked to discuss only", async () => {
  const calls = stubJev({ choice: "block", confidence: 0.93 });
  const call = fresh();
  const result = await call({ toolName: "edit", input: { path: "a.ts" } }, makeCtx());
  assert.equal(result?.block, true);
  assert.equal(calls.length, 1);
  const state = (calls[0] as any).state as string;
  assert.match(state, /Explain only/); // user request is sent
  assert.match(state, /I will implement option 2/); // assistant text is context, not authority
  assert.equal((calls[0] as any).questions.authorization.criteria.block.length > 0, true);
});

test("allows a guarded tool on explicit authorization and reuses the decision per user turn", async () => {
  const calls = stubJev({ choice: "allow", confidence: 0.88 });
  const call = fresh();
  const ctx = makeCtx({ user: "Implement the simplest solution now." });
  assert.equal(await call({ toolName: "edit", input: { path: "a.ts" } }, ctx), undefined);
  assert.equal(await call({ toolName: "bash", input: { command: "ls" } }, ctx), undefined);
  assert.equal(await call({ toolName: "write", input: { path: "b.ts" } }, ctx), undefined);
  assert.equal(calls.length, 1, "one Jev call per user turn");
});

test("asks the user when the verdict is ambiguous", async () => {
  stubJev({ choice: "ask", confidence: 0.99 });
  const call = fresh();
  const yes = await call({ toolName: "edit", input: {} }, makeCtx({ hasUI: true, confirm: true }));
  assert.equal(yes, undefined, "user approval executes the tool");

  stubJev({ choice: "ask", confidence: 0.99 });
  const call2 = fresh();
  const no = await call2({ toolName: "edit", input: {} }, makeCtx({ hasUI: true, confirm: false }));
  assert.equal(no?.block, true, "user refusal blocks the tool");
});

test("low confidence falls back to asking even on allow/block", async () => {
  stubJev({ choice: "allow", confidence: 0.4 });
  const call = fresh();
  const result = await call({ toolName: "bash", input: { command: "rm -rf x" } }, makeCtx({ hasUI: false }));
  assert.equal(result?.block, true);
});

test("fails closed when Jev is unavailable", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const call = fresh();
  assert.equal((await call({ toolName: "bash", input: {} }, makeCtx())).block, true);

  stubJev(undefined, "network down");
  process.env.TYPESAFE_API_KEY = "test-key";
  const call2 = fresh();
  assert.equal((await call2({ toolName: "bash", input: {} }, makeCtx({ hasUI: true, confirm: false }))).block, true);
});

test("Jev failure with UI lets the user decide", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const call = fresh();
  assert.equal(await call({ toolName: "write", input: {} }, makeCtx({ hasUI: true, confirm: true })), undefined);
});

test("ignores read-only tools and non-matching models", async () => {
  const calls = stubJev({ choice: "block", confidence: 0.99 });
  process.env.PI_INTENT_GUARD_MODELS = "deepseek,glm";
  const call = fresh();
  assert.equal(await call({ toolName: "read", input: {} }, makeCtx()), undefined, "read is not guarded");
  assert.equal(await call({ toolName: "edit", input: {} }, makeCtx({ model: "openai/gpt-5" })), undefined, "unmatched model skips the guard");
  assert.equal(calls.length, 0);
  assert.equal((await call({ toolName: "edit", input: {} }, makeCtx({ model: "glm/glm-4.6" })))?.block, true);
  assert.equal(calls.length, 1);
});

test("reads the key from config and gives the environment key precedence", async () => {
  delete process.env.TYPESAFE_API_KEY;
  await writeFile(join(testConfigDir, "intent-guard.json"), JSON.stringify({ typesafeApiKey: "file-key" }));

  const fileCalls = stubJev({ choice: "block", confidence: 0.99 });
  const fileResult = await fresh()({ toolName: "edit", input: {} }, makeCtx());
  assert.equal(fileResult?.block, true);
  assert.deepEqual(fileCalls.authorizations, ["Bearer file-key"]);

  process.env.TYPESAFE_API_KEY = "env-key";
  const envCalls = stubJev({ choice: "block", confidence: 0.99 });
  await fresh()({ toolName: "edit", input: {} }, makeCtx());
  assert.deepEqual(envCalls.authorizations, ["Bearer env-key"]);
});

test("intent-jev-key saves a private config file and activates the key", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const requests: Array<{ url: string; init: any }> = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    requests.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ models: [{}, {}] }) };
  };

  const { pi, command, hasCommand } = makePi();
  intentGuard(pi as any);
  assert.ok(hasCommand(), "extension must register /intent-jev-key");
  const notifications: Array<[string, string]> = [];
  await command("sk-test-key-123456789", {
    ui: {
      input: async () => undefined,
      notify: (message: string, level: string) => notifications.push([message, level]),
    },
  });

  const path = join(testConfigDir, "intent-guard.json");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { typesafeApiKey: "sk-test-key-123456789" });
  assert.equal((await stat(path)).mode & 0o777, 0o600, "saved key file must have mode 0600");
  assert.equal(process.env.TYPESAFE_API_KEY, "sk-test-key-123456789");
  assert.equal(requests[0]?.url, "https://api.typesafe.ai/v1/models");
  assert.equal(requests[0]?.init.headers.Authorization, "Bearer sk-test-key-123456789");
  assert.match(notifications[0]?.[0] ?? "", /validated \(2 models\)/);
});

test("blocks with no key in either environment or config", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const result = await fresh()({ toolName: "bash", input: {} }, makeCtx());
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /Jev was unavailable/);
});
