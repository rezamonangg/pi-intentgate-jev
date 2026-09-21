# Handoff: build `pi-jev-intent-guard`

## Objective

Create a very small open-source Pi extension that prevents the main coding model from taking **unrequested side effects**.

Primary examples of main models:

- DeepSeek Flash v4.1
- GLM 5.3 Flash
- Qwen / Kimi / Llama / Mistral-family models
- Any other Pi model when enabled

The extension must remain **model-agnostic**. Do not wrap or replace the model provider. Intercept Pi tool calls instead.

## Core user problem

Example:

```text
User: "What are the solutions based on the Oracle subagent?"
```

Expected:

1. consult/read Oracle result;
2. explain solutions;
3. stop and wait for the user.

Bad behavior:

1. consult Oracle;
2. choose a solution itself;
3. edit files/run commands without user authorization.

The extension exists to stop step 3.

## V0.1 scope

Keep the repository intentionally small.

Guard only these Pi tools:

```text
bash
powershell
write
edit
```

Do **not** gate ordinary read-only Pi tools such as:

```text
read
grep
find
ls
```

Do not gate Oracle/subagent tools unless explicitly configured later.

## Architecture

```text
User prompt
    |
Main model
    |
    +---- read/search/subagent -----------------> ALLOW
    |
    +---- bash/write/edit/powershell
                    |
                    v
                   Jev
                    |
             +------+------+ 
             |      |      |
           ALLOW   ASK   BLOCK
             |      |      |
           execute confirm stop
```

Pi already exposes a `tool_call` extension event before tool execution. Use it. Do not monkey-patch Pi internals.

## Jev decision

Use the TypeSafe HTTP API directly to keep dependencies near zero.

Endpoint:

```text
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
```

Default model:

```text
jev-latest
```

Ask one `choice` question named `authorization` with exactly three outcomes:

```text
allow
ask
block
```

Important semantics:

- Only USER messages grant authorization.
- Assistant statements such as "I will implement this" never count as permission.
- `allow`: user clearly asked to implement/modify/create/run/fix/delete/install/commit/deploy/etc.
- `block`: user asked only to explain/analyze/compare/review/discuss/brainstorm/inspect/report.
- `ask`: genuinely ambiguous intent.

Include in Jev state:

- active Pi model id/provider;
- pending tool name;
- truncated tool arguments;
- recent user/assistant conversation;
- explicit reminder that only user messages grant authority.

## Policy

Default confidence threshold:

```text
0.75
```

Behavior:

```text
allow + confidence >= threshold
    -> allow tool

block + confidence >= threshold
    -> block tool

ask OR confidence < threshold
    -> ctx.ui.confirm(...)

Jev/API failure
    -> ask user when UI is available
    -> otherwise block
```

Fail safe. Do not silently allow on classifier/network failure.

## Important optimization

Cache the authorization decision **per latest user turn**.

Reason:

```text
User: "Implement option 2"
```

The first `edit` may call Jev and return `allow`. Subsequent `edit`/`bash` calls in the same turn should reuse the decision.

This keeps Jev cheap and prevents one request per tool call.

Reset naturally when a new user message appears by using the latest user message entry ID as the cache key.

## Model filtering

Default: apply to all models.

Support optional environment variable:

```bash
PI_INTENT_GUARD_MODELS="deepseek,glm,qwen,kimi,llama,mistral"
```

Use case-insensitive substring matching against the active Pi provider/model string.

This lets a user guard only open/open-weight models if desired.

## Configuration

Environment variables only for V0.1:

```bash
TYPESAFE_API_KEY=...
JEV_MODEL=jev-latest
PI_INTENT_GUARD_MODELS=deepseek,glm
PI_INTENT_GUARD_TOOLS=bash,powershell,write,edit
PI_INTENT_GUARD_CONFIDENCE=0.75
PI_INTENT_GUARD_MAX_STATE_CHARS=8000
```

Avoid a config framework in V0.1.

## Repository structure

```text
pi-jev-intent-guard/
├── extensions/
│   └── intent-guard.ts
├── .gitignore
├── HANDOFF.md
├── LICENSE
├── README.md
└── package.json
```

No build output should be committed.

## Pi package manifest

`package.json` must contain:

```json
{
  "keywords": ["pi-package"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "pi": {
    "extensions": ["./extensions/intent-guard.ts"]
  }
}
```

## Local verification

Set a real TypeSafe key:

```bash
export TYPESAFE_API_KEY="..."
pi -e .
```

Test these scenarios manually.

### Test A: discussion-only

Prompt:

```text
What possible solutions would you recommend? Explain only.
```

Then induce/observe a `write`, `edit`, or `bash` attempt.

Expected:

```text
blocked or asks for confirmation
```

### Test B: explicit implementation

Prompt:

```text
Implement the simplest solution now.
```

Expected:

```text
first side-effect call is classified allow;
subsequent guarded calls in that user turn reuse the cached allow.
```

### Test C: ambiguous

Prompt:

```text
Maybe we should fix this.
```

Expected:

```text
confirmation dialog
```

### Test D: Jev unavailable

Unset key:

```bash
unset TYPESAFE_API_KEY
```

Expected in interactive Pi:

```text
confirmation dialog
```

Expected headless:

```text
block
```

### Test E: model filter

```bash
export PI_INTENT_GUARD_MODELS="deepseek,glm"
```

Expected:

- DeepSeek/GLM -> guard active.
- unmatched model -> guard skipped.

## Publish on GitHub

Create a public repository named:

```text
pi-jev-intent-guard
```

Then:

```bash
git init
git add .
git commit -m "feat: initial Jev intent guard for Pi"
git branch -M main
git remote add origin git@github.com:<YOUR_GITHUB>/pi-jev-intent-guard.git
git push -u origin main
```

Users install it with:

```bash
pi install git:github.com/<YOUR_GITHUB>/pi-jev-intent-guard
```

## Non-goals for V0.1

Do not add these yet:

- full security/destructive-command classifier;
- sandboxing;
- policy DSL;
- database;
- web UI;
- model routing;
- automatic subagent routing;
- large dependency tree;
- complex read-only shell parser;
- npm publishing workflow.

Other Pi/Jev projects already cover broader risk/security classification. This repository should stay differentiated around **user authorization / over-execution**.

## Possible V0.2

Only after V0.1 is proven useful:

1. `/intent-guard on|off|status` command.
2. project/user JSON config.
3. shadow mode that logs decisions without blocking.
4. audit entries in the Pi session.
5. allowlist known read-only bash commands.
6. tests around pure policy logic.
7. optional second Jev question for destructive risk.

Do not implement V0.2 features in the initial version unless required to fix correctness.

## Definition of done

V0.1 is done when:

- it installs with `pi -e .`;
- it intercepts guarded tools before execution;
- Jev returns `allow / ask / block`;
- discussion-only prompts cannot silently mutate the repo;
- explicit implementation prompts still work without repeated Jev calls per tool;
- API failure does not silently allow execution;
- README explains install, environment variables, example behavior, and limitations;
- repository stays small enough to understand in a few minutes.
