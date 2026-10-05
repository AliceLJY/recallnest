/**
 * `ingest` 命令在对话入库关着（默认）时真跑一遍（2026-10-06）。
 *
 * ingest-plan.test.ts 钉的是「计划」和 cli.ts 的源码形状；这里起一个本地的假嵌入接口、放一份解析得出来的
 * Claude Code 对话在来源目录里，把命令当子进程跑完，看三件事：
 *   - 库里一行没多；
 *   - 假接口只收到开头那一次连通性检查，没有任何一段对话被送去嵌入；
 *   - 输出里说清了对话入库已关。
 * 只跑关着的这一侧：开着时 ingest 会往仓库自己的 data/ingested-files.json 记台账（路径按源码位置算，
 * 不看 RECALLNEST_DATA_DIR），在真实工作区里跑测试会写进生产台账。
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseCCTranscript } from "../ingest.js";
import { MemoryStore } from "../store.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const BUN = Bun.which("bun")!;
const DIM = 8;
const tmpDirs: string[] = [];
const servers: Server[] = [];

/**
 * 存档目录按源码位置算（<仓库>/data/minis-archive），不看 RECALLNEST_DATA_DIR。下面那条用例里的半截文件，
 * 代码正确时不会被挪进去；万一哪天代码改坏了，它会被挪进这个真实目录（Deja 会去读它）。
 * 所以不管用例过没过，收尾时都把这个文件名从存档目录里拿掉——只拿用例自己造的这一个名字。
 */
const HALF_WRITTEN_NAME = "conversation-测试用-写到一半-ingest-gate-cli.jsonl";
const STRAY_IN_REAL_ARCHIVE = join(REPO_ROOT, "data", "minis-archive", HALF_WRITTEN_NAME);

afterAll(async () => {
  for (const s of servers) await new Promise<void>((done) => s.close(() => done()));
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  rmSync(STRAY_IN_REAL_ARCHIVE, { force: true });
});

interface MockEmbeddings {
  baseURL: string;
  /** 每次请求里 input 的条数 */
  inputs: number[];
}

async function mockEmbeddings(): Promise<MockEmbeddings> {
  const inputs: number[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let input: unknown = [];
      try { input = (JSON.parse(raw) as { input?: unknown }).input ?? []; } catch { /* 当空 */ }
      const texts = Array.isArray(input) ? input : [input];
      inputs.push(texts.length);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        model: "test-model",
        data: texts.map((_, index) => ({ object: "embedding", index, embedding: Array.from({ length: DIM }, (_v, i) => (i + 1) / DIM) })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }));
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}/v1`, inputs };
}

function turn(type: "user" | "assistant", uuid: string, parentUuid: string | null, content: string) {
  return { type, sessionId: "5d0c6d1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f", uuid, parentUuid, timestamp: "2026-10-06T01:00:00+08:00", message: { role: type, content } };
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "rn-ingest-gate-cli-"));
  tmpDirs.push(root);
  const dataDir = join(root, "data");
  const ccDir = join(root, "cc-project");
  mkdirSync(dataDir);
  mkdirSync(ccDir);
  const transcript = join(ccDir, "5d0c6d1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f.jsonl");
  writeFileSync(transcript, [
    turn("user", "u1", null, "帮我看一下昨天那个定时任务为什么半夜没有跑起来，日志里只有一行开始、没有结束，我怀疑是代理的问题。"),
    turn("assistant", "u2", "u1", "我查了日志：任务确实在三点整启动了，随后在验证嵌入接口那一步卡住，两小时后被超时保护终止。原因是直连接口时域名解析被污染，走系统代理之后恢复正常。"),
    turn("user", "u3", "u2", "那就让它以后都走代理，另外失败的时候要发一条通知给我，不要再悄悄地失败。"),
    turn("assistant", "u4", "u3", "已经改好：脚本启动时加载代理配置，超时与非零退出各发一条通知，并以真实退出码结束，调度方看得见失败。"),
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");

  const dbPath = join(dataDir, "lancedb");
  const store = new MemoryStore({ dbPath, vectorDim: DIM });
  await store.storeBatch([{ text: "库里原有的一行，用来确认行数没有变", vector: Array.from({ length: DIM }, (_, i) => (i + 1) / DIM), category: "facts", scope: "project:seed", importance: 0.5, metadata: "{}" }]);

  const mock = await mockEmbeddings();
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({
    dbPath,
    embedding: { provider: "jina", apiKey: "test-key-not-used", model: "test-model", baseURL: mock.baseURL, dimensions: DIM },
    sources: { cc: { path: ccDir, glob: "*.jsonl", description: "test" } },
  }));
  return { dataDir, dbPath, transcript, configPath, mock };
}

/** 子进程要异步等：假接口跑在本进程里，同步等待会把它也卡住。 */
function runIngest(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // 代理变量会把发往 127.0.0.1 的请求带走；开关变量不能从外面漏进来
    if (v === undefined || /^(https?|all|no)_proxy$/i.test(k) || k === "RECALLNEST_TRANSCRIPT_INGEST") continue;
    childEnv[k] = v;
  }
  return new Promise((done, fail) => {
    const child = spawn(BUN, ["run", join(REPO_ROOT, "src/cli.ts"), "ingest", ...args], { cwd: REPO_ROOT, env: { ...childEnv, NO_PROXY: "127.0.0.1,localhost", ...env } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error(`ingest 子进程 60 秒没结束，已输出：${out.slice(-500)}`)); }, 60_000);
    child.on("close", (code) => { clearTimeout(timer); done({ code, out }); });
  });
}

/** 一个连不上的地址：本机 9 号端口没有服务，连接会被立刻拒绝 */
const DEAD_EMBEDDINGS = "http://127.0.0.1:9/v1";

async function rowCount(dbPath: string): Promise<number> {
  const store = new MemoryStore({ dbPath, vectorDim: DIM });
  return (await store.list(undefined, undefined, 100, 0)).length;
}

describe("ingest 命令：对话入库关着（默认）", () => {
  it("来源目录里的对话是解析得出来的（否则下面的「没入库」什么都证明不了）", async () => {
    const h = await harness();
    expect(parseCCTranscript(h.transcript).length).toBeGreaterThan(0);
  });

  it.each([["--source", "all"], ["--source", "cc"]])("ingest %s %s：不嵌入、不写库、说清没有执行", async (...args) => {
    const h = await harness();
    const r = await runIngest(args, { LOCAL_MEMORY_CONFIG: h.configPath, RECALLNEST_DATA_DIR: h.dataDir });

    expect(r.out).toContain("对话入库已关");
    expect(r.out).not.toContain("导入 Claude Code 对话");
    expect(r.code).toBe(0);
    // 只有开头那一次连通性检查（一条 "test"），没有任何对话切片被送去嵌入
    expect(h.mock.inputs).toEqual([1]);
    expect(await rowCount(h.dbPath)).toBe(1);
  }, 90_000);

  it("嵌入接口不通时命令照旧以 1 退出，但 Minis 挪存档那一步已经在它之前跑过了", async () => {
    const h = await harness();
    // 投递目录里只放一个格式不合规的文件：挪存档这一步会把它留在原处并报出来。
    // 这样既能从输出看出这一步确实跑了，又不会真的往仓库的 data/minis-archive 里挪东西（那个目录按源码位置算）
    const drop = join(h.dataDir, "..", "minis-drop");
    mkdirSync(drop);
    const bad = join(drop, "conversation-格式坏了.jsonl");
    writeFileSync(bad, JSON.stringify({ sessionId: "x", text: "没有 type 和 message 字段" }) + "\n");
    // 关着时只挪至少 60 秒没被改过的文件：把它的修改时间拨到五分钟前，否则这一轮它只会被留给下一轮、什么都不报
    const fiveMinutesAgo = new Date(Date.now() - 300_000);
    utimesSync(bad, fiveMinutesAgo, fiveMinutesAgo);
    const cfg = JSON.parse(readFileSync(h.configPath, "utf-8"));
    cfg.embedding.baseURL = DEAD_EMBEDDINGS;
    cfg.sources = { minis: { path: drop, glob: "*.jsonl", description: "test" } };
    writeFileSync(h.configPath, JSON.stringify(cfg));

    // 再放一个只写了一半的：第一行是完整的一轮，第二行断在中间。解析会跳过残缺行，所以它「有可用的对话」；
    // 命令要是不另外看「文件写完没有」，就会把它当成完整的挪进仓库的存档目录、把原件删掉
    const half = join(drop, HALF_WRITTEN_NAME);
    writeFileSync(half, JSON.stringify(turn("user", "u1", null, "这一行是完整的，下一行写到一半就断了，文件其实还没有导出完。")) + "\n" + JSON.stringify(turn("assistant", "u2", "u1", "这一行会被截断在中间，后半句不存在")).slice(0, 60));
    utimesSync(half, fiveMinutesAgo, fiveMinutesAgo);
    expect(parseCCTranscript(half).length).toBeGreaterThan(0);

    const r = await runIngest(["--source", "all"], { LOCAL_MEMORY_CONFIG: h.configPath, RECALLNEST_DATA_DIR: h.dataDir });

    expect(r.code).toBe(1);
    expect(r.out).toContain("Embedding API 验证失败");
    expect(r.out).toContain("Minis 对话：不入库，只挪存档");
    expect(r.out).toContain("conversation-格式坏了.jsonl: 没有可用的对话行");
    expect(r.out).toContain(`${HALF_WRITTEN_NAME}: 没有可用的对话行（格式不合规或还没写完）`);
    expect(r.out).toContain("0 个移入");
    expect(existsSync(half)).toBe(true);
    expect(existsSync(STRAY_IN_REAL_ARCHIVE)).toBe(false);
    expect(r.out.indexOf("只挪存档")).toBeLessThan(r.out.indexOf("Embedding API 验证失败"));
    expect(existsSync(join(drop, "conversation-格式坏了.jsonl"))).toBe(true);
    expect(await rowCount(h.dbPath)).toBe(1);
  }, 90_000);
});

