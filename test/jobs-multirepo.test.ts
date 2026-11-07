import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { jobs, landJobs, locateIdRoot, repoNamePattern, type WorkerContext } from "../src/jobs.js";

const cwd0 = process.cwd();
let parent: string | undefined;
afterEach(() => {
  process.chdir(cwd0);
  if (parent) rmSync(parent, { recursive: true, force: true });
  parent = undefined;
});

/** A non-git parent folder holding git repos named `names`. */
function workspace(names: string[]) {
  parent = realpathSync.native(mkdtempSync(join(tmpdir(), "cheapag-multi-")));
  const dirs = names.map((n) => {
    const d = join(parent!, n);
    mkdirSync(d);
    execFileSync("git", ["init", "-q", d]);
    return d;
  });
  process.chdir(parent);
  return dirs;
}

test("repoNamePattern escapes regex characters and handles names bordered by '-'", () => {
  for (const name of ["c++", "app(1)", "my.app", "-x-", "a[b]", "x$y", "a\b"]) {
    const re = repoNamePattern(name);
    expect(re.test(`edit ${name} please`), name).toBe(true);
    expect(re.test(`edit ${name}`), name).toBe(true);
  }
  expect(repoNamePattern("my.app").test("my-app")).toBe(false);
  expect(repoNamePattern("app").test("webapp")).toBe(false);
  expect(repoNamePattern("app").test("app2")).toBe(false);
  expect(repoNamePattern("APP").test("fix app now")).toBe(true);
});

test("locateIdRoot finds job ids and batch ids in the sub-repo that holds them", () => {
  const [a, b] = workspace(["one", "two"]);
  mkdirSync(join(a, ".cheapag", "jobs", "j1111"), { recursive: true });
  mkdirSync(join(b, ".cheapag", "batches"), { recursive: true });
  writeFileSync(join(b, ".cheapag", "batches", "b2222.json"), "{}");
  expect(locateIdRoot(parent!, "j1111")).toBe(a);
  expect(locateIdRoot(parent!, "b2222")).toBe(b);
  expect(locateIdRoot(parent!, "j9999")).toBeUndefined();
  expect(locateIdRoot(parent!, "../x")).toBeUndefined();
});

test("jobs show/wait/cancel error clearly for ids found in no sub-repo", async () => {
  workspace(["one", "two"]);
  expect(await jobs({ action: "show", job: "j9999" })).toBe(`FAIL reason: job j9999 not found in any repository under ${parent}`);
  expect(await jobs({ action: "wait", job: "b9999" })).toBe(`FAIL reason: batch b9999 not found in any repository under ${parent}`);
  expect(await jobs({ action: "cancel", job: "j9999" })).toMatch(/not found in any repository/);
});

test("landJobs resolves each id's repo and rejects ids spanning repos", async () => {
  const [a, b] = workspace(["one", "two"]);
  mkdirSync(join(a, ".cheapag", "jobs", "j1111"), { recursive: true });
  mkdirSync(join(b, ".cheapag", "jobs", "j2222"), { recursive: true });
  const ctx = {} as WorkerContext;
  const span = await landJobs({ job: "j1111,j2222", action: "discard" }, ctx);
  expect(span).toMatch(/span several repositories/);
  expect(await landJobs({ job: "j1111,j9999", action: "discard" }, ctx)).toBe("FAIL reason: no job j9999 found in any repository");
});
