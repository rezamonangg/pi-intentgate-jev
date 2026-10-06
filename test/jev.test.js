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
  const pi = { on: (_, fn) => { handler = fn; } };
  const ctx = {
    cwd: repo, hasUI: true,
    ui: { select: async (text) => { title = text; return answer; } },
  };
  const call = (command = "git status", workdir) => handler({
    toolName: "exec_command", input: { cmd: command, workdir },
  }, ctx);
  try {
    jev(pi);
    assert.equal(await call(), undefined);
    assert.match(title, /50% \(0 yes \/ 0 no\)/);
    answer = "No";
    assert.equal((await call()).block, true);
    assert.match(title, /67% \(1 yes \/ 0 no\)/);
    const saved = readFileSync(file, "utf8");
    assert.deepEqual(JSON.parse(saved).entries[0], {
      repo, cwd: repo, command: "git status", yes: 1, no: 1,
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
    writeFileSync(file, "{broken");
    assert.equal((await call()).block, true);
    assert.equal(readFileSync(file, "utf8"), "{broken");
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ yes: -1 }] }));
    assert.equal((await call()).block, true);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});
