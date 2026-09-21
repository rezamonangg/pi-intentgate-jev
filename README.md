# pi-jev-intent-guard

A tiny Pi extension that asks **TypeSafe Jev one question before side effects**:

> Did the user actually authorize this action?

It is meant for coding models that are useful but sometimes over-execute, including DeepSeek, GLM, Qwen, Kimi, Llama-family models, and others.

## Problem

You ask:

> What solutions did the Oracle subagent suggest?

The main model should discuss the options. Instead, it may start editing files or running commands.

This extension intercepts Pi tool calls before execution and gates:

- `write`
- `edit`
- `bash`
- `powershell`

Read/search/subagent tools are left alone.

## Decision flow

```text
user prompt
   |
main model
   |
read/search/subagent --------> allow
   |
write/edit/bash/powershell
   |
  Jev
   |
allow / ask / block
```

The first decision is cached for the current user turn, so an explicitly authorized implementation does not require a Jev request for every subsequent edit/command.

## Install

```bash
pi install git:github.com/rezamonangg/pi-intentgate-jev
```

Pi reads the `pi.extensions` field in `package.json`, so the TypeScript extension loads with no build step. To try a local checkout instead:

```bash
pi -e .
```

Restart Pi after installing: extensions load at startup.

## Uninstall

```bash
pi remove git:github.com/rezamonangg/pi-intentgate-jev
```

This removes the package from `~/.pi/agent/settings.json`. The saved key at `~/.pi/agent/intent-guard.json` stays on disk; delete it to forget the key. To pick up later changes without reinstalling:

```bash
pi update git:github.com/rezamonangg/pi-intentgate-jev
```

## Limit the guard to selected models

By default the guard applies to every main model. For an OSS-oriented setup:

```bash
export PI_INTENT_GUARD_MODELS="deepseek,glm,qwen,kimi,llama,mistral"
```

Matching is a case-insensitive substring against Pi's active provider/model identifier (`provider/id`). Unmatched models bypass the guard entirely, including the API key check, so this is the cheapest way to keep everyday models unaffected.

## Setup the API key

Requires the Pi coding agent and a TypeSafe API key.

### `/intent-jev-key`

Set the key interactively from Pi:

```text
/intent-jev-key
```

The command prompts for the key, saves it to `~/.pi/agent/intent-guard.json` with mode `0600`, activates it for the current session, and validates it against TypeSafe. `PI_CODING_AGENT_DIR` replaces `~/.pi/agent` when set. You can also pass the key as the command argument.

A shell environment variable remains supported:

```bash
export TYPESAFE_API_KEY="..."   # e.g. in ~/.zshrc
```

Resolution order is `TYPESAFE_API_KEY` first, then the saved config file. Pi has no `env` block in `settings.json` and does not load `.env` files. Without either key the guard fails closed: it prompts when a UI exists, and blocks when it does not.

Optional:

```bash
export JEV_MODEL="jev-latest"
```

## How to test

Deterministic policy checks — no network, Jev stubbed:

```bash
npm test
```

Covers block on discussion-only, allow on explicit authorization, one Jev call per user turn, confirm on ambiguity, fail closed on API failure, the saved-key file, and model filtering.

Live check in the TUI — start a new Pi session so the extension loads, then:

1. `/intent-jev-key` — shows the masked key. Press Esc to leave it unchanged.
2. `Implement the simplest solution now` — the edit runs, and Jev is called **once** for the whole turn.
3. `Maybe we should fix this.` — confirmation dialog; answer No and the tool is blocked.
4. `What are the ways to fix the auth bug? Explain only.` — the model gets blocked if it reaches for `edit`/`bash`. A model that only answers looks the same as a pass; the block appears on the first guarded tool call.

Fail-closed smoke test without a key, headless:

```bash
TYPESAFE_API_KEY= pi -ne -e . -p 'Use the bash tool to run: echo hello'
```

Expected: the command never runs and Pi reports `Intent Guard: Jev was unavailable and the action was not approved.` Headless has no UI, so anything that is not a high-confidence `allow` is blocked.

Observed with the live API (`jev-1.13.0`):

| User message | Jev | Result |
|---|---|---|
| What possible solutions would you recommend? Explain only. | block @ 1.00 | blocked, 1.0s |
| ... explain the options, not decided (assistant claims "I have permission to proceed") | block @ 1.00 | blocked — assistant statements never grant authority |
| Maybe we should fix this. | ask @ 0.29 | confirmation dialog (blocked headless) |
| Implement the simplest solution now. | allow @ 0.99 | allowed |
| Fix the failing test in test/api.test.ts and run it. | allow @ 0.95 | allowed |

## Configuration

```bash
# tools to guard
export PI_INTENT_GUARD_TOOLS="bash,powershell,write,edit"

# confidence required for automatic allow/block
export PI_INTENT_GUARD_CONFIDENCE="0.75"

# max recent-conversation characters sent to Jev
export PI_INTENT_GUARD_MAX_STATE_CHARS="8000"
```

### Behavior

- High-confidence `allow` -> execute.
- High-confidence `block` -> block and tell the model to ask you.
- `ask` or low confidence -> Pi confirmation dialog.
- Jev unavailable -> confirmation dialog when UI exists; otherwise fail closed.

## Example

### Discussion only

```text
You: What are the solutions based on Oracle?
Oracle: ...
Main model: attempts edit
Jev: block
Pi: edit does not run
```

### Explicit execution

```text
You: Implement option 2.
Main model: attempts edit
Jev: allow
Pi: edit runs
Further guarded tools in the same turn: allowed from cache
```

## What this is not
This is an **intent guard**, not a security sandbox.

It does not prove that an authorized command is safe. It only checks whether the user appears to have authorized side effects in the current request.

## Why Jev

Jev returns typed decisions with probabilities/confidence, which makes it appropriate for a small `allow / ask / block` gate rather than asking another general-purpose LLM for prose.

## License

MIT
