import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import jev from "../index.js";

test("approval gate learns explicit votes, isolates history, and fails closed", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jev-")));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const repo = join(root, "repo");
  const other = join(root, "other");
  mkdirSync(repo);
  mkdirSync(other);
  execFileSync("git", ["init", "-q", repo]);
  const file = join(root, ".agent", "jev-learning.json");
  let handler;
  let answer = "Yes";
  let title;
  let prompts = 0;
  const pi = { on: (_, fn) => { handler = fn; } };
  const ctx = {
    cwd: repo, hasUI: true,
    ui: { select: async (text) => { title = text; prompts++; return answer; } },
  };
  const call = (command = "git status", workdir) => handler({
    toolName: "exec_command", input: { cmd: command, workdir },
  }, ctx);
  try {
    jev(pi);
    assert.equal(await call(), undefined);
    assert.match(title, /50% \(0 yes \/ 0 no\)/);
    answer = undefined;
    assert.equal((await call("git status --short")).block, true);
    assert.match(title, /67% \(1 yes \/ 0 no\)/); // Arguments share the family score.
    answer = "No";
    assert.equal((await call()).block, true);
    assert.match(title, /67% \(1 yes \/ 0 no\)/);
    const saved = readFileSync(file, "utf8");
    assert.deepEqual(JSON.parse(saved).entries[0], {
      repo, cwd: repo, family: "git status", yes: 1, no: 1,
    });
    assert.equal(statSync(file).mode & 0o777, 0o600);

    jev(pi); // Reload must preserve scores.
    answer = undefined;
    assert.equal((await call()).block, true);
    assert.match(title, /50% \(1 yes \/ 1 no\)/);
    assert.equal(readFileSync(file, "utf8"), saved);
    await call("git reset --hard");
    assert.match(title, /50% \(0 yes \/ 0 no\)/);
    await call("git status", other);
    assert.match(title, /50% \(0 yes \/ 0 no\)/);
    assert.equal(readFileSync(file, "utf8"), saved);

    ctx.hasUI = false;
    answer = "Yes";
    assert.equal((await call()).block, true);
    ctx.hasUI = true;
    assert.equal(await handler({ toolName: "read", input: {} }, ctx), undefined);
    assert.equal(readFileSync(file, "utf8"), saved);

    mkdirSync(`${file}.lock`);
    assert.equal((await call()).block, true);
    assert.equal(readFileSync(file, "utf8"), saved);
    rmSync(`${file}.lock`, { recursive: true });

    assert.equal(await handler({ toolName: "bash", input: { command: "git status" } }, ctx), undefined);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).entries[0].yes, 2);

    const beforeBundle = prompts;
    assert.equal(await call('git status && git commit -m "message; git reset && echo no" && GIT_EDITOR=true git push'), undefined);
    assert.equal(prompts, beforeBundle + 1);
    assert.match(title, /git status: 60% \(2 yes \/ 1 no\)/);
    let entries = JSON.parse(readFileSync(file, "utf8")).entries;
    assert.deepEqual(entries.map((e) => e.family), ["git status", "git commit", "git push"]);
    assert.equal(entries[0].yes, 3);
    assert.equal(await call('git commit -m "different message"'), undefined);
    assert.match(title, /git commit: 67% \(1 yes \/ 0 no\)/);
    answer = "No";
    assert.equal((await call("git push --force")).block, true);
    assert.match(title, /git push: 67% \(1 yes \/ 0 no\)/);
    assert.match(title, /git push --force/); // The full command still needs approval.
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).entries[2], {
      repo, cwd: repo, family: "git push", yes: 1, no: 1,
    });

    answer = "Yes";
    assert.equal(await call("git status; git status --short"), undefined);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).entries[0].yes, 4); // Once per bundle.
    assert.equal(await call("printf '%s' 'literal && git clean; git reset' && git -C . status --short 2>/dev/null | sed -n '1,5p'"), undefined);
    entries = JSON.parse(readFileSync(file, "utf8")).entries;
    assert.deepEqual(entries.map((e) => e.family), ["git status", "git commit", "git push", "printf", "sed"]);

    const beforeUnsupported = readFileSync(file, "utf8");
    for (const command of ["echo $(git status)", "echo `git status`", "echo $HOME", "for x in a; do git status; done", "cat <<EOF\ngit status\nEOF", 'git commit -m "unfinished']) {
      assert.equal(await call(command), undefined);
      assert.match(title, /History not recorded/);
      assert.equal(readFileSync(file, "utf8"), beforeUnsupported);
    }
    answer = "No";
    assert.equal((await call("echo $(git status)")).block, true);
    assert.equal(readFileSync(file, "utf8"), beforeUnsupported);
    answer = "Yes";

    const legacy = [
      { repo, cwd: repo, command: "git status", yes: 20, no: 1 },
      { repo, cwd: repo, command: "git status && git push", yes: 10, no: 0 },
    ];
    writeFileSync(file, JSON.stringify({ version: 1, entries: legacy }));
    assert.equal(await call(), undefined);
    assert.match(title, /git status: 50% \(0 yes \/ 0 no\)/);
    const migrated = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.legacyEntries, legacy);
    assert.deepEqual(migrated.entries, [{ repo, cwd: repo, family: "git status", yes: 1, no: 0 }]);
    writeFileSync(file, "{broken");
    assert.equal((await call()).block, true);
    assert.equal((await call("echo $(git status)")).block, true);
    assert.equal(readFileSync(file, "utf8"), "{broken");
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ yes: -1 }] }));
    assert.equal((await call()).block, true);
    writeFileSync(file, JSON.stringify({ version: 2, entries: [{ repo, cwd: repo, family: "git status", yes: -1, no: 0 }], legacyEntries: [] }));
    assert.equal((await call()).block, true);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});
