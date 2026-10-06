# pi-intentgate-jev

JEV asks before every `bash` or `exec_command` tool call and shows approval
history for each command family in that repo and working directory. It never
automatically approves a command. Other tools aren't gated; this isn't a sandbox.

Try from this directory:

```sh
npm install
pi --extension ./index.js
```

For a persistent personal install: `pi install .` then reload Pi.

Startup shows “JEV active”. To trigger an approval prompt, ask Pi to run
`git status`. The history file appears after your first explicit Yes/No answer.

## Learning

- One global file: `~/.agent/jev-learning.json`, not inside your repos.
- One prompt approves or declines the **full command bundle**. Each explicit
  Yes/No records one vote per distinct family, even if it appears multiple times.
  These are approvals of bundles containing that family, not isolated judgments.
  Escape/cancel and non-interactive calls are blocked without recording a vote.
  No is the default selection. Scores never bypass approval.
- Score: `100 × (yes + 1) / (yes + no + 2)`, rounded. New commands start at 50%.
  This predicts your approval preference, **not safety or successful execution**.
- Families ignore arguments: `git commit -m "first"` and `git commit -m "second"`
  share `git commit`. Git subcommands stay separate (`git status` vs `git reset`);
  other executables use their command name. `git push --force` shares `git push`
  history, **not permission**. The full command, including flags, is always shown.
- Quoted `&&` and `;` remain arguments. Static single-line bundles, pipes,
  environment assignments, and ordinary redirections can be scored. Variables,
  substitutions, control flow, multiline commands, and unsupported syntax still
  require approval but record no history. JEV does not inspect scripts or unwrap
  commands run through `sudo`, `sh`, or similar wrappers.
- Git roots and starting working directories use canonical absolute paths.
  Outside Git, history is grouped by working directory. JEV does not model
  directory changes inside a bundle.
- Scores are calculated from counts on each ask; counts persist across restarts.
- New entries store `family`, not full command strings. Version-1 exact-command
  history is preserved under `legacyEntries` on the next recorded vote, without
  transferring its scores. Legacy strings may contain secrets. File permissions
  are owner-only. Avoid putting secrets directly in commands.

Reload Pi after updating, including other sessions using JEV: old code cannot
read version-2 history and will block commands rather than overwrite it.

Updates use an exclusive lock directory and atomic file replacement. Corrupt
history, write failures, or a busy lock block execution rather than erase history.
After a crash, remove `~/.agent/jev-learning.json.lock` **only after confirming no
JEV process is writing**. Votes record your answer, not command completion;
another extension may still deny a command you approved here.

Run checks: `npm test`. Start with `index.js` to modify gating or scoring.
