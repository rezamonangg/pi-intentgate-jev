# pi-intentgate-jev

JEV asks before every `bash` or `exec_command` tool call and shows your approval
history for that exact command in that repo and working directory. It never
automatically approves a command. Other tools aren't gated; this isn't a sandbox.

Try from this directory:

```sh
pi --extension ./index.js
```

For a persistent personal install: `pi install .` then reload Pi.

Startup shows “JEV active”. To trigger an approval prompt, ask Pi to run
`git status`. The history file appears after your first explicit Yes/No answer.

## Learning

- One global file: `~/.agent/jev-learning.json`, not inside your repos.
- Each explicit Yes/No updates its counts. Escape/cancel and non-interactive
  calls are blocked without recording a vote. No is the default selection.
- Score: `100 × (yes + 1) / (yes + no + 2)`, rounded. New commands start at 50%.
  This predicts your approval preference, **not safety or successful execution**.
- Git roots and working directories use canonical absolute paths. Outside Git,
  history is grouped by working directory. Exact command text is not generalized;
  `git status` approval never transfers to `git reset`.
- Scores are calculated from counts on each ask; counts persist across restarts.
  Command strings are stored locally and may contain secrets. File permissions
  are owner-only. Avoid putting secrets directly in commands.

Updates use an exclusive lock directory and atomic file replacement. Corrupt
history, write failures, or a busy lock block execution rather than erase history.
After a crash, remove `~/.agent/jev-learning.json.lock` **only after confirming no
JEV process is writing**. Votes record your answer, not command completion;
another extension may still deny a command you approved here.

Run checks: `npm test`. Start with `index.js` to modify gating or scoring.
