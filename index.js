import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "shell-quote";

function commandFamilies(command) {
  // ponytail: learn static, single-line commands only; use a full shell AST if complex syntax needs scores.
  if (command.length > 16 * 1024 || /[\r\n]/.test(command)) return [];
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = "";
    } else if (char === "\\") {
      if (++i >= command.length) return [];
    } else if (char === "$" || char === "`") {
      return []; // Never expand variables or inspect guessed command substitutions.
    } else if (char === "'" && !quote) {
      quote = "'";
    } else if (char === '"') {
      quote = quote ? "" : '"';
    }
  }
  if (quote) return [];

  const groups = [];
  let words = [];
  let redirect = false;
  for (const token of parse(command)) {
    if (typeof token === "string" || token.op === "glob") {
      if (redirect) redirect = false;
      else words.push(token);
    } else if (token.comment !== undefined) {
      break;
    } else if ([";", "&&", "||", "|", "|&", "&"].includes(token.op)) {
      if (redirect) return [];
      if (words.length) groups.push(words);
      words = [];
    } else if (["<", ">", ">>", "<&", ">&", "<>", ">|", "&>", "&>>"].includes(token.op)) {
      if (redirect) return [];
      if (/^\d+$/.test(words.at(-1))) words.pop(); // Redirection file descriptor.
      redirect = true;
    } else {
      return []; // Groups, heredocs, and other shell constructs aren't simple commands.
    }
  }
  if (redirect) return [];
  if (words.length) groups.push(words);

  const families = [];
  for (const group of groups) {
    const start = group.findIndex((word) => typeof word !== "string" || !/^[A-Za-z_][\w]*=/.test(word));
    if (start < 0) continue; // Assignment without a command.
    const executable = group[start];
    if (typeof executable !== "string" || !/^[\w./-]+$/.test(executable) ||
        /^(if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|time|coproc)$/.test(executable)) return [];
    let family = executable;
    if (/(^|\/)git$/.test(executable)) {
      family = "git";
      for (let i = start + 1; i < group.length; i++) {
        const word = group[i];
        if (typeof word !== "string") break;
        if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(word)) {
          i++; // These global options take an argument, not a subcommand.
        } else if (/^--(git-dir|work-tree|namespace|config-env)=/.test(word) ||
                   ["--bare", "--no-pager", "--paginate", "-p", "-P", "--no-replace-objects"].includes(word)) {
          continue;
        } else {
          if (/^[a-z][a-z0-9-]*$/.test(word)) family = `git ${word}`;
          break;
        }
      }
    }
    families.push(family);
  }
  return [...new Set(families)];
}

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
      if (error.code === "ENOENT") return { version: 2, entries: [], legacyEntries: [] };
      throw error;
    }
    const validEntries = (entries, key) => Array.isArray(entries) &&
        entries.every((e) => e && typeof e.repo === "string" &&
          typeof e.cwd === "string" && typeof e[key] === "string" && e[key].length > 0 &&
          Number.isSafeInteger(e.yes) && e.yes >= 0 &&
          Number.isSafeInteger(e.no) && e.no >= 0 && Number.isSafeInteger(e.yes + e.no + 2));
    if (data?.version === 1 && validEntries(data.entries, "command")) {
      // Keep old exact-command votes intact; they are not family-level votes.
      return { version: 2, entries: [], legacyEntries: data.entries };
    }
    if (data?.version !== 2 || !validEntries(data.entries, "family") || !validEntries(data.legacyEntries, "command")) {
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
      const families = commandFamilies(command);
      const matches = (e, family) => e.repo === repo && e.cwd === cwd && e.family === family;
      const data = read();
      const history = families.map((family) => {
        const previous = data.entries.find((e) => matches(e, family)) ?? { yes: 0, no: 0 };
        const score = Math.round(100 * (previous.yes + 1) / (previous.yes + previous.no + 2));
        return `${family}: ${score}% (${previous.yes} yes / ${previous.no} no)`;
      }).join("\n") || "History not recorded: unsupported or no command families.";
      const choice = await ctx.ui.select(
        `JEV approval history by command family:\n${history}\n` +
        `Not a safety estimate. Approval always required.\nRepo: ${repo}\nDirectory: ${cwd}\n\n${command}\n\nAllow?`,
        ["No", "Yes"],
      );
      if (choice !== "Yes" && choice !== "No") return blocked("cancelled; nothing learned");
      if (!families.length) return choice === "No" ? blocked("declined by user") : undefined;

      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const lock = `${file}.lock`;
      // ponytail: fail closed on lock contention; add bounded retries if busy writers become common.
      mkdirSync(lock, { mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const data = read(); // Re-read under the lock so concurrent sessions don't lose votes.
        for (const family of families) {
          let entry = data.entries.find((e) => matches(e, family));
          if (!entry) {
            entry = { repo, cwd, family, yes: 0, no: 0 };
            data.entries.push(entry);
          }
          if (!Number.isSafeInteger(entry.yes + entry.no + 3)) throw new Error("Vote count limit reached");
          entry[choice === "Yes" ? "yes" : "no"]++;
        }
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
