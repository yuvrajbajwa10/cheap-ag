import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { agyBinary, openAgySession, ensureAgyAcp, stopAgyAcp } from "../src/antigravity.js";
import { detectProvider, PROVIDERS, savedProviders } from "../src/credentials.js";
import { fullRoute, PRESETS, ROLES } from "../src/routing.js";
import { hermeticHome } from "./harness.js";
import { loadConfig } from "../src/config.js";

test("PROVIDERS list includes antigravity", () => {
  const agy = PROVIDERS.find((p) => p.id === "antigravity");
  expect(agy).toBeDefined();
  expect(agy?.label).toBe("Antigravity CLI (agy)");
});

test("detectProvider recognizes antigravity configured in user config", () => {
  const { home, env } = hermeticHome();
  const oldEnv = { ...process.env };
  try {
    process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
    const configDir = join(home, "config", "cheapag");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ provider: "antigravity" }));

    const saved = savedProviders();
    expect(saved).toContain("antigravity");

    const detected = detectProvider();
    expect(detected?.provider).toBe("antigravity");
  } finally {
    process.env = oldEnv;
  }
});

test("routing for antigravity resolves default roles, presets and custom models", () => {
  expect(ROLES.antigravity).toBeDefined();
  expect(PRESETS.antigravity).toBeDefined();

  const defaultRoute = fullRoute("antigravity");
  expect(defaultRoute.implement.providerID).toBe("antigravity");
  expect(defaultRoute.implement.id).toBe("gemini-3.8-flash");
  expect(defaultRoute.escalation?.id).toBe("claude-sonnet-4-6");

  const customRoute = fullRoute("antigravity", {
    implement: "antigravity/gemini-3.8-flash-high",
    escalation: "antigravity/claude-opus-4-6-thinking",
  });
  expect(customRoute.implement.id).toBe("gemini-3.8-flash-high");
  expect(customRoute.escalation?.id).toBe("claude-opus-4-6-thinking");

  // Bare model names without prefix
  const bareRoute = fullRoute("antigravity", {
    implement: "gemini-3.8-flash-medium",
  });
  expect(bareRoute.implement.id).toBe("gemini-3.8-flash-medium");
});

test("config schema validates provider and agy_path properties", () => {
  const { home } = hermeticHome();
  const configDir = join(home, "config", "cheapag");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      provider: "antigravity",
      agy_path: "C:\\custom\\agy.exe",
      models: { implement: "antigravity/gemini-3.8-flash" },
    }),
  );

  const oldEnv = { ...process.env };
  try {
    process.env.XDG_CONFIG_HOME = join(home, "config");
    const cfg = loadConfig(home);
    expect(cfg.provider).toBe("antigravity");
    expect(cfg.agy_path).toBe("C:\\custom\\agy.exe");
    expect(cfg.models.implement).toBe("antigravity/gemini-3.8-flash");
  } finally {
    process.env = oldEnv;
  }
});

test("agyBinary locates installed agy executable", () => {
  const bin = agyBinary();
  expect(bin).toBeTruthy();
  expect(existsSync(bin)).toBe(true);
});

test("openAgySession runs prompt over ACP and returns valid SessionTotals and RunResult", async () => {
  const { home } = hermeticHome();
  const session = await openAgySession({
    directory: home,
    model: { providerID: "antigravity", id: "gemini-3.8-flash" },
  });
  onTestFinished(async () => {
    await stopAgyAcp();
  });

  expect(session.sessionID).toBeTruthy();
  const initialTotals = session.totals();
  expect(initialTotals.sessionID).toBe(session.sessionID);
  expect(initialTotals.turns).toBe(0);

  const res = await session.run("Respond with a test report:\n```cheapag-result\nsummary: completed test\nrisks:\n- none\nreview:\n- test.ts:1-5\nmissing:\nrepro: n/a\ndisagree: none\n```");
  expect(res.error).toBeUndefined();
  expect(res.finish?.summary).toBe("completed test");
  expect(res.finish?.risks).toContain("none");
  expect(res.finish?.repro).toBe("n/a");

  const finalTotals = session.totals();
  expect(finalTotals.turns).toBeGreaterThan(0);
  expect(finalTotals.usage.inputTokens).toBeGreaterThan(0);
}, 60_000);
