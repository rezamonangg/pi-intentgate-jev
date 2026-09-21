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

## Requirements

- Pi coding agent
- TypeSafe API key

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

## Install from GitHub

After publishing this repository:

```bash
pi install git:github.com/YOUR_GITHUB/pi-jev-intent-guard
```

Or test a local checkout:

```bash
pi -e .
```

Pi packages can declare extensions in `package.json`, so no build step is required for this TypeScript extension.

## Limit the guard to selected models

By default the guard applies to every main model.

For an OSS-oriented setup:

```bash
export PI_INTENT_GUARD_MODELS="deepseek,glm,qwen,kimi,llama,mistral"
```

Matching is a case-insensitive substring against Pi's active provider/model identifier.

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

## Tests

```bash
npm test
```

Stubs Jev and checks the policy: block on discussion-only, allow on explicit authorization, one Jev call per user turn, confirm on ambiguity, fail closed on API failure, and model filtering. The live scenarios (A-E in `HANDOFF.md`) need a real `TYPESAFE_API_KEY`.

## What this is not
This is an **intent guard**, not a security sandbox.

It does not prove that an authorized command is safe. It only checks whether the user appears to have authorized side effects in the current request.

## Why Jev

Jev returns typed decisions with probabilities/confidence, which makes it appropriate for a small `allow / ask / block` gate rather than asking another general-purpose LLM for prose.

## License

MIT
