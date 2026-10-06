import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export default function jev(pi) {
  const file = join(homedir(), ".agent", "jev-learning.json");

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify(`JEV active: commands require approval. History: ${file}`, "info");
  });

  function read() {
    let data;
    try {
      if (statSync(file).size > 5 * 1024 * 1024) throw new Error("Learning file exceeds 5 MiB");
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, entries: [] };
      throw error;
    }
    if (data?.version !== 1 || !Array.isArray(data.entries) ||
        !data.entries.every((e) => e && typeof e.repo === "string" &&
          typeof e.cwd === "string" && typeof e.command === "string" &&
          Number.isSafeInteger(e.yes) && e.yes >= 0 &&
          Number.isSafeInteger(e.no) && e.no >= 0 && Number.isSafeInteger(e.yes + e.no + 2))) {
      throw new Error("Invalid JEV learning file; repair it before retrying");
    }
    return data;
  }

  pi.on("tool_call", async (event, ctx) => {
    if (!["bash", "exec_command", "functions.exec_command"].includes(event.toolName)) return;
    const blocked = (reason) => ({ block: true, reason: `JEV: ${reason}` });
    if (!ctx.hasUI) return blocked("interactive approval required");
    try {
      const command = event.toolName === "bash" ? event.input.command : event.input.cmd;
      if (typeof command !== "string" || !command.trim()) return blocked("missing command");
      const workdir = event.input.workdir;
      if (workdir !== undefined && typeof workdir !== "string") return blocked("invalid workdir");
      const cwd = realpathSync(resolve(ctx.cwd, workdir ?? "."));
      let repo = cwd;
      try {
        repo = realpathSync(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
          encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
        }).trim());
      } catch {
        // Outside Git (or Git unavailable), isolate history by working directory.
      }
      const matches = (e) => e.repo === repo && e.cwd === cwd && e.command === command;
      const previous = read().entries.find(matches) ?? { yes: 0, no: 0 };
      const score = Math.round(100 * (previous.yes + 1) / (previous.yes + previous.no + 2));
      const choice = await ctx.ui.select(
        `JEV approval history: ${score}% (${previous.yes} yes / ${previous.no} no)\n` +
        `Not a safety estimate. Approval always required.\nRepo: ${repo}\nDirectory: ${cwd}\n\n${command}\n\nAllow?`,
        ["No", "Yes"],
      );
      if (choice !== "Yes" && choice !== "No") return blocked("cancelled; nothing learned");

      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const lock = `${file}.lock`;
      // ponytail: fail closed on lock contention; add bounded retries if busy writers become common.
      mkdirSync(lock, { mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const data = read(); // Re-read under the lock so concurrent sessions don't lose votes.
        let entry = data.entries.find(matches);
        if (!entry) {
          entry = { repo, cwd, command, yes: 0, no: 0 };
          data.entries.push(entry);
        }
        if (!Number.isSafeInteger(entry.yes + entry.no + 3)) throw new Error("Vote count limit reached");
        entry[choice === "Yes" ? "yes" : "no"]++;
        const contents = `${JSON.stringify(data, null, 2)}\n`;
        if (Buffer.byteLength(contents) > 5 * 1024 * 1024) throw new Error("Learning file exceeds 5 MiB");
        writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
        renameSync(temporary, file);
      } finally {
        rmSync(temporary, { force: true });
        rmSync(lock, { recursive: true, force: true });
      }
      if (choice === "No") return blocked("declined by user");
    } catch (error) {
      return blocked(`approval/history failed: ${error.message}`);
    }
  });
}
