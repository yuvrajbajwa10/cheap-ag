import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { consentGate, describe, writeConsent, type Consent } from "./consent.js";
import { detectProvider, LOGIN_COMMAND, providerLabel, redact } from "./credentials.js";
import { modelName, routeModels } from "./routing.js";
import { findSubRepositories, NotGitRepoError, projectRoot } from "./workspace.js";

const USAGE = "usage: cheapag allow [--zdr-only | --models <provider/model,…>] [--repo <path>]";

/**
 * `cheapag allow`: the developer's opt-in for the current repo (spec: Consent). Non-interactive, so the plugin's
 * user-only `/cheapag:allow` can wrap it. No MCP tool calls this. Modes: all models (no flag), zero-retention only,
 * or an explicit model list. The consent is for the provider logged in now; a later switch asks again.
 */
export function allow(argv: string[]): number {
  const out = (line: string) => process.stdout.write(redact(line) + "\n");
  // `--repo <path>` names the one repo to allow; it is the only way to allow from outside a repo
  let repoArg: string | undefined;
  const args = [...argv];
  const at = args.indexOf("--repo");
  if (at >= 0) {
    repoArg = args[at + 1];
    if (!repoArg || repoArg.startsWith("--")) {
      out(`✗ ${USAGE}`);
      return 1;
    }
    args.splice(at, 2);
  }
  let consent: Omit<Consent, "provider" | "approvedAt">;
  if (!args.length) consent = { mode: "all" };
  else if (args.length === 1 && args[0] === "--zdr-only") consent = { mode: "zdr-only" };
  else if (args.length === 2 && args[0] === "--models" && args[1].split(",").some((m) => m.trim())) {
    consent = { mode: "models", models: args[1].split(",").map((m) => m.trim()).filter(Boolean) };
  } else {
    out(`✗ ${USAGE}`);
    return 1;
  }
  const provider = detectProvider();
  if (!provider) {
    out(`✗ no worker provider; run ${LOGIN_COMMAND} first`);
    return 1;
  }
  let roots: string[];
  try {
    roots = [projectRoot(repoArg ? resolve(repoArg) : process.cwd())];
  } catch (err) {
    if (!(err instanceof NotGitRepoError)) {
      out(`✗ ${(err as Error).message}`);
      return 1;
    }
    const sub = repoArg ? [] : findSubRepositories(process.cwd());
    if (sub.length) {
      out(`✗ ${process.cwd()} is not inside a git repository. Found ${sub.length} in subfolders; nothing was allowed. Pick one with: cheapag allow --repo <path>`);
      for (const s of sub) out(`  ${s}`);
    } else {
      out(`✗ ${err.message}${repoArg ? "" : ", and no git repositories were found in subfolders"}`);
    }
    return 1;
  }
  for (const root of roots) {
    const prefix = "";
    const record: Consent = { ...consent, provider: provider.provider, approvedAt: new Date().toISOString() };
    writeConsent(root, record);
    out(`${prefix}✓ ${root}: code may go to ${providerLabel(provider.provider)} (${describe(record)})`);
    // the same gate delegate uses, so what this prints is what jobs will run
    const gate = consentGate(root, provider.provider);
    if ("block" in gate) out(`${prefix}! ${gate.block}`);
    else out(`${prefix}  models: ${routeModels(gate.route).map(modelName).join(", ")}`);
    // .cheapag/ state is local: keep it out of `git status` without touching the repo's tracked .gitignore
    if (spawnSync("git", ["check-ignore", "-q", ".cheapag"], { cwd: root, stdio: "pipe" }).status !== 0) {
      mkdirSync(join(root, ".git", "info"), { recursive: true });
      appendFileSync(join(root, ".git", "info", "exclude"), ".cheapag/\n");
      out(`${prefix}✓ .cheapag/ added to .git/info/exclude (local, never committed)`);
    }
  }
  return 0;
}
