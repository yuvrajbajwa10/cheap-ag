import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { mainFingerprint } from "../src/jobs.js";
import { tempRepo } from "./harness.js";

test("mainFingerprint: unchanged by .cheapag/, changed by a tracked edit or a new untracked file", () => {
  const repo = tempRepo();
  onTestFinished(repo.cleanup);
  const base = mainFingerprint(repo.dir);
  mkdirSync(join(repo.dir, ".cheapag", "jobs"), { recursive: true });
  writeFileSync(join(repo.dir, ".cheapag", "jobs", "x"), "log");
  expect(mainFingerprint(repo.dir)).toBe(base);
  writeFileSync(join(repo.dir, "README.md"), "# edited\n");
  const edited = mainFingerprint(repo.dir);
  expect(edited).not.toBe(base);
  writeFileSync(join(repo.dir, "README.md"), "# edited again\n"); // an already-dirty file edited further
  expect(mainFingerprint(repo.dir)).not.toBe(edited);
  writeFileSync(join(repo.dir, "new.txt"), "x");
  expect(mainFingerprint(repo.dir)).not.toBe(edited);
});
