import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { killProcessGroup, which } from "./platform.js";
import { finishReport, type FinishReport, type RunResult, type Session, type SessionTotals, type Usage } from "./worker.js";
import type { WorkerModel } from "./routing.js";

/**
 * Antigravity ACP Engine: communicates with Antigravity CLI (`agy acp`) over stdio JSON-RPC.
 * Parallels the OpenCode server & worker architecture.
 */

export function agyBinary(customPath?: string): string {
  if (customPath && existsSync(customPath)) return customPath;
  const onPath = which("agy");
  if (onPath) return onPath;
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    const defaultWin = join(localAppData, "agy", "bin", "agy.exe");
    if (existsSync(defaultWin)) return defaultWin;
  }
  throw new Error("no Antigravity CLI ('agy') binary found on PATH or configuration; ensure agy is installed");
}

export class AgyAcpClient {
  private child: ChildProcess;
  private reqId = 1;
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private sessionListeners = new Map<string, (update: any) => void>();
  private buffer = "";
  public version = "unknown";

  constructor(binaryPath: string) {
    this.child = spawn(binaryPath, ["acp", "--dangerously-skip-permissions"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) {
              reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              resolve(msg.result);
            }
          } else if (msg.method === "session/update" && msg.params?.sessionId) {
            const listener = this.sessionListeners.get(msg.params.sessionId);
            if (listener) listener(msg.params.update);
          }
        } catch {
          // ignore unparseable line
        }
      }
    });

    this.child.on("error", (err) => {
      for (const { reject } of this.pending.values()) {
        reject(err);
      }
      this.pending.clear();
    });

    this.child.on("exit", (code) => {
      const err = new Error(`agy acp process exited with code ${code}`);
      for (const { reject } of this.pending.values()) {
        reject(err);
      }
      this.pending.clear();
    });
  }

  public isAlive(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }

  public async init(): Promise<void> {
    const res = await this.request("initialize", {
      clientInfo: { name: "cheapag", version: "1.3.2" },
    });
    if (res?.agentInfo?.version) {
      this.version = String(res.agentInfo.version);
    }
  }

  public request(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.isAlive()) return Promise.reject(new Error("agy acp process is not running"));
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.child.stdin?.write(payload, "utf8", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  public onSessionUpdate(sessionId: string, listener: (update: any) => void): () => void {
    this.sessionListeners.set(sessionId, listener);
    return () => {
      if (this.sessionListeners.get(sessionId) === listener) {
        this.sessionListeners.delete(sessionId);
      }
    };
  }

  public close(): void {
    if (this.child.pid) {
      killProcessGroup(this.child.pid);
    }
  }
}

let activeClient: AgyAcpClient | undefined;
let activeClientPromise: Promise<AgyAcpClient> | undefined;

export async function ensureAgyAcp(customPath?: string): Promise<AgyAcpClient> {
  if (activeClient && activeClient.isAlive()) return activeClient;
  if (activeClientPromise) return activeClientPromise;
  activeClientPromise = (async () => {
    const bin = agyBinary(customPath);
    const client = new AgyAcpClient(bin);
    await client.init();
    activeClient = client;
    activeClientPromise = undefined;
    return client;
  })().catch((err) => {
    activeClientPromise = undefined;
    throw err;
  });
  return activeClientPromise;
}

export async function stopAgyAcp(): Promise<void> {
  if (activeClient) {
    const client = activeClient;
    activeClient = undefined;
    client.close();
  }
}

const WORKER_INSTRUCTIONS = `You implement plan steps in this repository by editing files yourself.
- Stay within the step's files and make precise edits. If you must edit anything else, report it under risks.
- Never install packages or run install commands.
- Never touch .git, .env* files or lockfiles. Never commit.
- If the step fixes a bug or wrong behavior, prove it: first write a small test that reproduces the problem and verify it fails, then fix the code and verify it passes.
- Proceed autonomously without asking questions or pausing for approval. Make reasonable choices and document any assumptions under risks.
- When done, end your final answer with a single fenced code block exactly matching this format:
\`\`\`cheapag-result
summary: <what you did, at most 160 characters>
risks:
- <any risks, assumptions, unverified conditions>
review:
- <path:start-end for lines needing review>
missing:
- <anything not completed>
repro: <test command or 'none: why' or 'n/a'>
disagree: <disagreements with spec or 'none'>
\`\`\`
`;

export async function openAgySession(opts: {
  directory: string;
  model: WorkerModel;
  agent?: string;
  signal?: AbortSignal;
  onEvent?: (event: any, turns: number) => void;
  customPath?: string;
}): Promise<Session> {
  const client = await ensureAgyAcp(opts.customPath);
  const created = await client.request("session/new", { cwd: opts.directory });
  if (!created?.sessionId) throw new Error(`could not create an Antigravity ACP session: ${JSON.stringify(created)}`);
  const sessionID: string = created.sessionId;

  // Set mode to accept-edits so file edits proceed without prompt
  await client.request("session/set_config_option", {
    sessionId: sessionID,
    configId: "mode",
    value: "accept-edits",
  }).catch(() => {});

  // Set model if specified
  const modelId = opts.model?.id;
  if (modelId) {
    await client.request("session/set_config_option", {
      sessionId: sessionID,
      configId: "model",
      value: modelId,
    }).catch(() => {});
  }

  let turns = 0;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  const spend: Record<string, number> = {};

  function totals(): SessionTotals {
    return {
      sessionID,
      turns,
      usage: { ...usage },
      rejections: [],
      spend: { ...spend },
    };
  }

  async function run(prompt: string, modelOverride?: WorkerModel, interrupt?: AbortSignal, afterStop = false): Promise<RunResult> {
    const signal = afterStop ? undefined : opts.signal;
    if (signal?.aborted || interrupt?.aborted) return { text: "", error: "aborted" };

    if (modelOverride?.id) {
      await client.request("session/set_config_option", {
        sessionId: sessionID,
        configId: "model",
        value: modelOverride.id,
      }).catch(() => {});
    }

    let assistantText = "";
    let activeToolName: string | undefined;

    const cleanupListener = client.onSessionUpdate(sessionID, (update) => {
      if (!update) return;
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.text) {
        assistantText += update.content.text;
      } else if (update.sessionUpdate === "tool_call" && update.name) {
        activeToolName = update.name;
      } else if (update.sessionUpdate === "tool_call_update") {
        const tool = update.name || activeToolName || "tool";
        if (update.status === "completed" || update.status === "error") {
          turns++;
          opts.onEvent?.({
            type: "message.part.updated",
            properties: {
              part: {
                type: "tool",
                tool,
                state: {
                  status: update.status,
                  input: update.args || update.rawInput || {},
                },
              },
            },
          }, turns);
        }
      }
    });

    const onAbort = () => {
      void client.request("session/cancel", { sessionId: sessionID }).catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    interrupt?.addEventListener("abort", onAbort, { once: true });

    try {
      // Prepend instructions if not already present
      const fullPrompt = prompt.includes("cheapag-result") ? prompt : `${WORKER_INSTRUCTIONS}\n\n${prompt}`;
      const res = await client.request("session/prompt", {
        sessionId: sessionID,
        prompt: [{ type: "text", text: fullPrompt }],
      });

      if (res?.usage) {
        const inTok = Number(res.usage.inputTokens ?? 0);
        const outTok = Number(res.usage.outputTokens ?? 0);
        const thoughtTok = Number(res.usage.thoughtTokens ?? 0);
        const cacheRead = Number(res.usage.cachedReadTokens ?? 0);
        const cacheWrite = Number(res.usage.cachedWriteTokens ?? 0);
        usage.inputTokens += inTok;
        usage.outputTokens += outTok;
        usage.reasoningTokens += thoughtTok;
        usage.cacheRead += cacheRead;
        usage.cacheWrite += cacheWrite;
      }

      // If turns was never bumped by tool calls, bump at least once for the prompt turn
      if (turns === 0) turns = 1;

      const finish: FinishReport = finishReport({ finish: undefined, text: assistantText });
      return {
        finish,
        text: assistantText,
      };
    } catch (err) {
      if (signal?.aborted || interrupt?.aborted) return { text: assistantText, error: "aborted", interrupted: true };
      return { text: assistantText, error: (err as Error).message };
    } finally {
      cleanupListener();
      signal?.removeEventListener("abort", onAbort);
      interrupt?.removeEventListener("abort", onAbort);
    }
  }

  return {
    sessionID,
    totals,
    run,
  };
}
