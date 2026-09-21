import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Verdict = "allow" | "ask" | "block";

type CachedDecision = {
  turnKey: string;
  verdict: Verdict;
};

const DEFAULT_TOOLS = ["bash", "powershell", "write", "edit"];
const DEFAULT_CONFIDENCE = 0.75;
const DEFAULT_MAX_STATE_CHARS = 8000;

function configPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "intent-guard.json");
}

async function storedApiKey(): Promise<string | undefined> {
  try {
    const key = JSON.parse(await readFile(configPath(), "utf8"))?.typesafeApiKey;
    return typeof key === "string" ? key.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

async function apiKey(): Promise<string | undefined> {
  return process.env.TYPESAFE_API_KEY?.trim() || storedApiKey();
}

function maskedKey(key: string): string {
  return key.length > 10 ? `${key.slice(0, 6)}...${key.slice(-4)}` : "*".repeat(key.length);
}

async function saveApiKey(key: string): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ typesafeApiKey: key }), { mode: 0o600 });
  await chmod(path, 0o600);
}

function csvEnv(name: string, fallback: string[]): string[] {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function getRecentConversation(ctx: any, maxChars: number): {
  text: string;
  latestUserText: string;
  latestUserKey: string;
} {
  const branch = ctx.sessionManager.getBranch() as any[];
  const messages: Array<{ id?: string; role: string; text: string }> = [];

  for (const entry of branch) {
    if (entry?.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = textFromContent(entry.message?.content).trim();
    if (!text) continue;
    messages.push({ id: entry.id, role, text });
  }

  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  const recent = messages.slice(-8);
  let text = recent
    .map((message) => `${message.role.toUpperCase()}:\n${message.text}`)
    .join("\n\n");

  if (text.length > maxChars) text = text.slice(-maxChars);

  return {
    text,
    latestUserText: latestUser?.text ?? "",
    latestUserKey: latestUser?.id ?? latestUser?.text ?? "no-user-message",
  };
}

function modelMatches(ctx: any): boolean {
  const filters = csvEnv("PI_INTENT_GUARD_MODELS", []);
  if (filters.length === 0) return true;

  const model = [ctx.model?.provider, ctx.model?.id, ctx.model?.name]
    .filter(Boolean)
    .join("/")
    .toLowerCase();

  return filters.some((filter) => model.includes(filter.toLowerCase()));
}

function safeJson(value: unknown, maxChars = 2000): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n...truncated` : text;
  } catch {
    return "[unserializable tool input]";
  }
}

async function askJev(state: string): Promise<{ verdict: Verdict; confidence: number }> {
  const key = await apiKey();
  if (!key) throw new Error("TYPESAFE_API_KEY is not set");

  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      state,
      model: process.env.JEV_MODEL || "jev-latest",
      questions: {
        authorization: {
          type: "choice",
          instructions:
            "Decide whether the USER authorized the pending side-effecting tool action. Only USER messages grant authority; assistant statements never grant permission. Choose allow only when the user asked to implement, modify, create, run, fix, delete, install, commit, deploy, or otherwise perform the relevant action. Choose block when the user asked only to explain, analyze, compare, review, discuss, brainstorm, inspect, or report. Choose ask when authorization is genuinely ambiguous or depends on an unstated assumption.",
          criteria: {
            allow: "The user authorized execution or side effects relevant to the current request.",
            ask: "Authorization is ambiguous; the user should be consulted before executing.",
            block: "The user requested information/discussion only or did not authorize side effects."
          }
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Jev request failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as any;
  const answer = body?.answers?.authorization;
  const verdict = answer?.choice as Verdict | undefined;
  const confidence = typeof answer?.confidence === "number" ? answer.confidence : 0;

  if (verdict !== "allow" && verdict !== "ask" && verdict !== "block") {
    throw new Error("Jev returned an unexpected authorization result");
  }

  return { verdict, confidence };
}

export default function intentGuard(pi: ExtensionAPI) {
  const guardedTools = new Set(csvEnv("PI_INTENT_GUARD_TOOLS", DEFAULT_TOOLS));
  const threshold = Number(process.env.PI_INTENT_GUARD_CONFIDENCE || DEFAULT_CONFIDENCE);
  const maxStateChars = Number(process.env.PI_INTENT_GUARD_MAX_STATE_CHARS || DEFAULT_MAX_STATE_CHARS);

  let cached: CachedDecision | undefined;

  pi.registerCommand("intent-jev-key", {
    description: "Save the TypeSafe API key for Intent Guard",
    handler: async (args, ctx) => {
      let key = args.trim();
      const existing = await apiKey();

      if (!key) {
        if (existing) ctx.ui.notify(`Current TypeSafe API key: ${maskedKey(existing)}`, "info");
        key = (await ctx.ui.input("TypeSafe API key:", "Paste TYPESAFE_API_KEY"))?.trim() ?? "";
        if (!key) {
          ctx.ui.notify(existing ? "TypeSafe API key unchanged." : "No TypeSafe API key saved.", "info");
          return;
        }
      }

      await saveApiKey(key);
      process.env.TYPESAFE_API_KEY = key;

      try {
        const response = await fetch("https://api.typesafe.ai/v1/models", {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as any;
        const models = Array.isArray(body) ? body : body?.models;
        ctx.ui.notify(`TypeSafe API key saved and validated (${Array.isArray(models) ? models.length : 0} models).`, "info");
      } catch (error) {
        ctx.ui.notify(
          `TypeSafe API key saved, but validation failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!guardedTools.has(event.toolName)) return;
    if (!modelMatches(ctx)) return;

    const conversation = getRecentConversation(ctx, maxStateChars);
    const turnKey = conversation.latestUserKey;

    if (cached?.turnKey === turnKey) {
      if (cached.verdict === "allow") return;
      return {
        block: true,
        reason: "Intent Guard: this turn has not been authorized for side effects. Ask the user before continuing."
      };
    }

    const state = [
      "Goal: decide whether the user authorized this pending tool action.",
      "Only USER messages are authoritative. Assistant messages are context only.",
      "",
      `ACTIVE MODEL: ${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}`,
      `PENDING TOOL: ${event.toolName}`,
      `PENDING INPUT:\n${safeJson(event.input)}`,
      "",
      "RECENT CONVERSATION:",
      conversation.text
    ].join("\n");

    let decision: { verdict: Verdict; confidence: number };

    try {
      decision = await askJev(state);
    } catch (error) {
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Intent Guard",
          `Jev is unavailable (${error instanceof Error ? error.message : "unknown error"}). Allow ${event.toolName}?`
        );
        cached = { turnKey, verdict: ok ? "allow" : "block" };
        if (ok) return;
      }

      cached = { turnKey, verdict: "block" };
      return {
        block: true,
        reason: "Intent Guard: Jev was unavailable and the action was not approved."
      };
    }

    if (decision.verdict === "allow" && decision.confidence >= threshold) {
      cached = { turnKey, verdict: "allow" };
      return;
    }

    if (decision.verdict === "block" && decision.confidence >= threshold) {
      cached = { turnKey, verdict: "block" };
      return {
        block: true,
        reason: "Intent Guard: the current user request appears discussion-only. Ask the user before making changes or running commands."
      };
    }

    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm(
        "Intent Guard",
        `The model wants to run ${event.toolName}, but authorization is ${decision.verdict} (${Math.round(decision.confidence * 100)}% confidence). Allow side effects for this turn?`
      );

      cached = { turnKey, verdict: ok ? "allow" : "block" };
      if (ok) return;
    } else {
      cached = { turnKey, verdict: "block" };
    }

    return {
      block: true,
      reason: "Intent Guard: action requires explicit user approval."
    };
  });
}
