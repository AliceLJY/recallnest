/**
 * 重写一条记忆的 trigger：先嵌入再动表、一次提交换新（2026-10-17 体检第 6 条）。
 *
 * 原先 upsertForMemory 先 delete、再调 embed（网络调用）、最后 add：
 *   - 嵌入失败时旧 trigger 已经删了，调用方只记一句「trigger 入口未写」；
 *   - 写锁只管本进程，两个进程同时重写同一条记忆会各删一遍、各加一遍，写出两组行。
 * 两个 TriggerStore 实例开同一个临时库，当作两个进程（各有各的写锁）。
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TriggerStore, TRIGGER_TABLE_NAME, triggerWriteLockKey } from "../trigger-store.js";
import { loadLanceDB } from "../store.js";
import { withWriteLock } from "../distill-lock.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

function tempDb(): string {
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-trigger-rewrite-"));
  cleanupPaths.push(dbPath);
  return dbPath;
}

/** 锁文件放在库目录旁边的临时目录里，不碰默认的 <dataDir>/locks。 */
function lockDirFor(dbPath: string): string {
  return join(dbPath, "..", `${dbPath.split("/").pop()}-locks`);
}

function openStore(dbPath: string, readConsistencyInterval = 0): TriggerStore {
  const lockDir = lockDirFor(dbPath);
  cleanupPaths.push(lockDir);
  return new TriggerStore({ dbPath, vectorDim: 3, readConsistencyInterval, lockDir });
}

const VEC: Record<string, number[]> = {
  "跑分要不要再跑": [1, 0, 0],
  "榜要不要去排名": [0.9, 0.1, 0],
  "老的要不要清掉": [0, 1, 0],
  "写入前要不要审": [0, 0, 1],
  "检索要不要换掉": [0.5, 0.5, 0],
};
const embed = async (texts: string[]) => texts.map((t) => VEC[t] ?? [0.33, 0.33, 0.33]);

interface StoredRow {
  id: string;
  memory_id: string;
  text: string;
}

/** 直接读侧表（另开连接），不经过被测的 TriggerStore。 */
async function readRows(dbPath: string, memoryId?: string): Promise<StoredRow[]> {
  const lancedb = await loadLanceDB();
  const db = await lancedb.connect(dbPath);
  const table = await db.openTable(TRIGGER_TABLE_NAME);
  let query = table.query().select(["id", "memory_id", "text"]);
  if (memoryId !== undefined) query = query.where(`memory_id = '${memoryId.replace(/'/g, "''")}'`);
  const rows = await query.toArray();
  return rows
    .map((r) => {
      const row = r as Record<string, unknown>;
      return { id: String(row.id), memory_id: String(row.memory_id), text: String(row.text) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 两次嵌入都被调到之后才一起返回：让两个写方在「已开始、未落表」那一刻对齐。 */
function barrierEmbed(parties: number): (texts: string[]) => Promise<number[][]> {
  let arrived = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async (texts: string[]) => {
    arrived += 1;
    if (arrived >= parties) release();
    await gate;
    return embed(texts);
  };
}

describe("upsertForMemory 嵌入失败时旧 trigger 不动", () => {
  it("嵌入抛错：旧的两行原样还在、仍搜得到", async () => {
    const dbPath = tempDb();
    const store = openStore(dbPath);
    await store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑", "榜要不要去排名"], embed);
    expect((await readRows(dbPath, "mem-A")).length).toBe(2);

    await expect(
      store.upsertForMemory("mem-A", "memory:pivot", ["老的要不要清掉"], async () => {
        throw new Error("embed 503");
      }),
    ).rejects.toThrow("embed 503");

    expect((await readRows(dbPath, "mem-A")).map((r) => r.text)).toEqual(["跑分要不要再跑", "榜要不要去排名"]);
    expect(await store.countForMemory("mem-A")).toBe(2);
    const hits = await store.search([1, 0, 0], 5, ["memory:pivot"], { minCosine: 0.95 });
    expect(hits.map((h) => h.memoryId)).toEqual(["mem-A"]);
  });

  it("嵌入返回条数对不上：抛错，旧行原样还在", async () => {
    const dbPath = tempDb();
    const store = openStore(dbPath);
    await store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑"], embed);

    await expect(
      store.upsertForMemory("mem-A", "memory:pivot", ["老的要不要清掉", "写入前要不要审"], async () => [[0, 1, 0]]),
    ).rejects.toThrow(/embed returned/);

    expect((await readRows(dbPath, "mem-A")).map((r) => r.text)).toEqual(["跑分要不要再跑"]);
  });
});

describe("upsertForMemory 一次提交换新", () => {
  it("由多变少：多出来的旧 id 删掉，别的记忆（含 id 带引号的）不受影响", async () => {
    const dbPath = tempDb();
    const store = openStore(dbPath);
    await store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑", "榜要不要去排名", "老的要不要清掉"], embed);
    await store.upsertForMemory("mem-'B", "memory:pivot", ["写入前要不要审", "检索要不要换掉"], embed);
    await store.upsertForMemory("mem-A2", "memory:pivot", ["跑分要不要再跑"], embed);

    expect(await store.upsertForMemory("mem-A", "memory:pivot", ["写入前要不要审"], embed)).toBe(1);

    const rows = await readRows(dbPath);
    expect(rows).toEqual([
      { id: "mem-'B#0", memory_id: "mem-'B", text: "写入前要不要审" },
      { id: "mem-'B#1", memory_id: "mem-'B", text: "检索要不要换掉" },
      { id: "mem-A#0", memory_id: "mem-A", text: "写入前要不要审" },
      { id: "mem-A2#0", memory_id: "mem-A2", text: "跑分要不要再跑" },
    ]);

    // 带引号的 id 重写同样只动自己
    await store.upsertForMemory("mem-'B", "memory:pivot", ["老的要不要清掉"], embed);
    expect((await readRows(dbPath)).map((r) => r.id)).toEqual(["mem-'B#0", "mem-A#0", "mem-A2#0"]);
  });

  it("一次重写只产生一个表版本（删旧与加新在同一个提交里，别的进程看不到中间态）", async () => {
    const dbPath = tempDb();
    const store = openStore(dbPath);
    await store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑", "榜要不要去排名", "老的要不要清掉"], embed);
    const lancedb = await loadLanceDB();
    const table = await (await lancedb.connect(dbPath)).openTable(TRIGGER_TABLE_NAME);
    const before = await table.version();

    await store.upsertForMemory("mem-A", "memory:pivot", ["写入前要不要审"], embed);
    await table.checkoutLatest();
    expect(await table.version()).toBe(before + 1);
    expect((await readRows(dbPath, "mem-A")).map((r) => r.text)).toEqual(["写入前要不要审"]);

    // 嵌入失败：一个版本都不多
    await expect(
      store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑"], async () => {
        throw new Error("embed 503");
      }),
    ).rejects.toThrow("embed 503");
    await table.checkoutLatest();
    expect(await table.version()).toBe(before + 1);
  });

  it("换新时向量也跟着换（按 id 覆盖，不是只改文字）", async () => {
    const dbPath = tempDb();
    const store = openStore(dbPath);
    await store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑"], embed);
    await store.upsertForMemory("mem-A", "memory:pivot", ["老的要不要清掉"], embed);
    expect((await store.search([1, 0, 0], 5, undefined, { minCosine: 0.95 })).length).toBe(0);
    const hits = await store.search([0, 1, 0], 5, undefined, { minCosine: 0.95 });
    expect(hits.map((h) => h.text)).toEqual(["老的要不要清掉"]);
  });
});

describe("两个进程同时重写同一条记忆", () => {
  it("同一组问法：两边嵌入对齐后各自落表，最后仍只有一组（原先是两组）", async () => {
    const dbPath = tempDb();
    const p1 = openStore(dbPath);
    const p2 = openStore(dbPath);
    await p1.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑", "榜要不要去排名"], embed);
    await p2.ready();

    const texts = ["老的要不要清掉", "写入前要不要审"];
    const gated = barrierEmbed(2);
    await Promise.all([
      p1.upsertForMemory("mem-A", "memory:pivot", texts, gated),
      p2.upsertForMemory("mem-A", "memory:pivot", texts, gated),
    ]);

    const rows = await readRows(dbPath, "mem-A");
    expect(rows.map((r) => r.id)).toEqual(["mem-A#0", "mem-A#1"]);
    expect(rows.map((r) => r.text)).toEqual(texts);
  });

  it("不同组问法、条数不同：结果是其中一方的整组，不混、不多（重复 8 轮）", async () => {
    const dbPath = tempDb();
    const p1 = openStore(dbPath);
    const p2 = openStore(dbPath);
    await p1.upsertForMemory("mem-A", "memory:pivot", ["检索要不要换掉"], embed);
    await p2.upsertForMemory("mem-other", "memory:pivot", ["检索要不要换掉"], embed);

    const three = ["跑分要不要再跑", "榜要不要去排名", "老的要不要清掉"];
    const two = ["写入前要不要审", "检索要不要换掉"];
    for (let round = 0; round < 8; round += 1) {
      const gated = barrierEmbed(2);
      const [a, b] = round % 2 === 0 ? [three, two] : [two, three];
      await Promise.all([
        p1.upsertForMemory("mem-A", "memory:pivot", a, gated),
        p2.upsertForMemory("mem-A", "memory:pivot", b, gated),
      ]);
      const texts = (await readRows(dbPath, "mem-A")).map((r) => r.text);
      const isThree = JSON.stringify(texts) === JSON.stringify(three);
      const isTwo = JSON.stringify(texts) === JSON.stringify(two);
      expect(isThree || isTwo).toBe(true);
    }
    expect((await readRows(dbPath, "mem-other")).map((r) => r.text)).toEqual(["检索要不要换掉"]);
  });
});


// ---------------------------------------------------------------------------
// 复审后补的（2026-10-17 owner 复审 PR #29 两条 P1）
// ---------------------------------------------------------------------------

async function openTable(dbPath: string) {
  const lancedb = await loadLanceDB();
  return (await lancedb.connect(dbPath)).openTable(TRIGGER_TABLE_NAME);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** 一个 promise 在给定时间内有没有落定（不改变它本身）。 */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  await new Promise((r) => setTimeout(r, ms));
  return done;
}

describe("复审 1：这条记忆还没有 trigger 时两个进程同时首写", () => {
  it("同一组问法：只有一组（只按 id 合并时双方都是插入、Lance 不判冲突，写出 4 行）", async () => {
    const dbPath = tempDb();
    const p1 = openStore(dbPath);
    const p2 = openStore(dbPath);
    await p1.ready();
    await p2.ready();

    const texts = ["老的要不要清掉", "写入前要不要审"];
    const gated = barrierEmbed(2);
    await Promise.all([
      p1.upsertForMemory("mem-A", "memory:pivot", texts, gated),
      p2.upsertForMemory("mem-A", "memory:pivot", texts, gated),
    ]);
    const rows = await readRows(dbPath, "mem-A");
    expect(rows.map((r) => r.id)).toEqual(["mem-A#0", "mem-A#1"]);
    expect(rows.map((r) => r.text)).toEqual(texts);
  });

  it("不同组问法、条数不同：每轮换一条新记忆，结果都是其中一方的整组（8 轮）", async () => {
    const dbPath = tempDb();
    const p1 = openStore(dbPath);
    const p2 = openStore(dbPath);
    await p1.ready();
    await p2.ready();

    const three = ["跑分要不要再跑", "榜要不要去排名", "老的要不要清掉"];
    const two = ["写入前要不要审", "检索要不要换掉"];
    for (let round = 0; round < 8; round += 1) {
      const memoryId = `mem-new-${round}`;
      const gated = barrierEmbed(2);
      const [a, b] = round % 2 === 0 ? [three, two] : [two, three];
      await Promise.all([
        p1.upsertForMemory(memoryId, "memory:pivot", a, gated),
        p2.upsertForMemory(memoryId, "memory:pivot", b, gated),
      ]);
      const texts = (await readRows(dbPath, memoryId)).map((r) => r.text);
      expect(JSON.stringify(texts) === JSON.stringify(three) || JSON.stringify(texts) === JSON.stringify(two)).toBe(true);
    }
  });

  it("拿到锁后先切到最新版本：句柄停在旧版本的进程重写时，别的进程刚写的行也一起换掉", async () => {
    const dbPath = tempDb();
    const stale = openStore(dbPath, 3600); // 一小时才自动刷新一次：句柄停在打开时的版本
    const other = openStore(dbPath);
    await stale.ready();
    await other.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑", "榜要不要去排名"], embed);

    expect(await stale.upsertForMemory("mem-A", "memory:pivot", ["写入前要不要审"], embed)).toBe(1);
    expect((await readRows(dbPath, "mem-A")).map((r) => r.text)).toEqual(["写入前要不要审"]);
  });
});

describe("复审 1：写表在跨进程锁里，嵌入在锁外", () => {
  it("别的进程占着锁时：嵌入照常发出，落表等到锁放开", async () => {
    const dbPath = tempDb();
    const store = openStore(dbPath);
    await store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑"], embed);

    const holding = deferred();
    const release = deferred();
    const holder = withWriteLock(triggerWriteLockKey(dbPath), async () => {
      holding.resolve();
      await release.promise;
    }, { lockDir: lockDirFor(dbPath) });
    await holding.promise;

    let embedCalled = false;
    const writing = store.upsertForMemory("mem-A", "memory:pivot", ["老的要不要清掉"], async (t) => {
      embedCalled = true;
      return embed(t);
    });
    expect(await settledWithin(writing, 300)).toBe(false);
    expect(embedCalled).toBe(true);
    expect((await readRows(dbPath, "mem-A")).map((r) => r.text)).toEqual(["跑分要不要再跑"]);

    release.resolve();
    await holder;
    expect(await writing).toBe(1);
    expect((await readRows(dbPath, "mem-A")).map((r) => r.text)).toEqual(["老的要不要清掉"]);
  });

  it("清空（规整后为空）也等锁", async () => {
    const dbPath = tempDb();
    const store = openStore(dbPath);
    await store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑"], embed);

    const holding = deferred();
    const release = deferred();
    const holder = withWriteLock(triggerWriteLockKey(dbPath), async () => {
      holding.resolve();
      await release.promise;
    }, { lockDir: lockDirFor(dbPath) });
    await holding.promise;

    const clearing = store.upsertForMemory("mem-A", "memory:pivot", ["x"], embed);
    expect(await settledWithin(clearing, 300)).toBe(false);
    expect((await readRows(dbPath, "mem-A")).length).toBe(1);

    release.resolve();
    await holder;
    expect(await clearing).toBe(0);
    expect((await readRows(dbPath, "mem-A")).length).toBe(0);
  });

  it("deleteForMemory 也等锁，返回删掉的行数", async () => {
    const dbPath = tempDb();
    const store = openStore(dbPath);
    await store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑", "榜要不要去排名"], embed);

    const holding = deferred();
    const release = deferred();
    const holder = withWriteLock(triggerWriteLockKey(dbPath), async () => {
      holding.resolve();
      await release.promise;
    }, { lockDir: lockDirFor(dbPath) });
    await holding.promise;

    const deleting = store.deleteForMemory("mem-A");
    expect(await settledWithin(deleting, 300)).toBe(false);
    expect((await readRows(dbPath, "mem-A")).length).toBe(2);

    release.resolve();
    await holder;
    expect(await deleting).toBe(2);
    expect((await readRows(dbPath, "mem-A")).length).toBe(0);
  });

  it("锁按库目录区分：别的库占着锁不挡这个库", async () => {
    const dbA = tempDb();
    const dbB = tempDb();
    expect(triggerWriteLockKey(dbA)).not.toBe(triggerWriteLockKey(dbB));
    expect(triggerWriteLockKey(dbA)).toBe(triggerWriteLockKey(join(dbA, ".")));
  });
});

describe("复审 2：旧竞态留下的同 id 重复行，重写时一并修掉", () => {
  async function seedDuplicates(dbPath: string, store: TriggerStore): Promise<void> {
    await store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑", "榜要不要去排名"], embed);
    await store.upsertForMemory("mem-B", "memory:pivot", ["检索要不要换掉"], embed);
    const table = await openTable(dbPath);
    // 旧代码两进程并发重写留下的样子：同一个 id 两行；其中一行 created_at 在将来（别的机器时钟快）
    await table.add([
      { id: "mem-A#0", memory_id: "mem-A", scope: "memory:pivot", text: "跑分要不要再跑", vector: [1, 0, 0], created_at: Date.now() + 86_400_000 },
      { id: "mem-A#1", memory_id: "mem-A", scope: "memory:pivot", text: "榜要不要去排名", vector: [0.9, 0.1, 0], created_at: 1 },
    ]);
    expect((await readRows(dbPath, "mem-A")).length).toBe(4);
  }

  it("重写：四行（两对同 id）换成新的两行，一个提交，别的记忆不动", async () => {
    const dbPath = tempDb();
    const store = openStore(dbPath);
    await seedDuplicates(dbPath, store);
    const table = await openTable(dbPath);
    const before = await table.version();

    expect(await store.upsertForMemory("mem-A", "memory:pivot", ["写入前要不要审", "老的要不要清掉"], embed)).toBe(2);

    expect(await readRows(dbPath, "mem-A")).toEqual([
      { id: "mem-A#0", memory_id: "mem-A", text: "写入前要不要审" },
      { id: "mem-A#1", memory_id: "mem-A", text: "老的要不要清掉" },
    ]);
    await table.checkoutLatest();
    expect(await table.version()).toBe(before + 1);
    expect((await readRows(dbPath, "mem-B")).map((r) => r.text)).toEqual(["检索要不要换掉"]);
  });

  it("同文重写（文字、id 都不变）也把重复行收成一组", async () => {
    const dbPath = tempDb();
    const store = openStore(dbPath);
    await seedDuplicates(dbPath, store);
    await store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑", "榜要不要去排名"], embed);
    expect((await readRows(dbPath, "mem-A")).map((r) => r.id)).toEqual(["mem-A#0", "mem-A#1"]);
  });

  it("清空与 deleteForMemory 都删得掉重复行", async () => {
    const dbPath = tempDb();
    const store = openStore(dbPath);
    await seedDuplicates(dbPath, store);
    expect(await store.upsertForMemory("mem-A", "memory:pivot", [], embed)).toBe(0);
    expect((await readRows(dbPath, "mem-A")).length).toBe(0);

    await seedDuplicates(dbPath, store);
    expect(await store.deleteForMemory("mem-A")).toBe(4);
    expect((await readRows(dbPath, "mem-A")).length).toBe(0);
  });

  it("同一毫秒里连写两次（created_at 撞上）：后一次照样换掉前一次", async () => {
    const dbPath = tempDb();
    const store = openStore(dbPath);
    await store.ready();
    const realNow = Date.now;
    const frozen = realNow();
    Date.now = () => frozen;
    try {
      await store.upsertForMemory("mem-A", "memory:pivot", ["跑分要不要再跑", "榜要不要去排名"], embed);
      await store.upsertForMemory("mem-A", "memory:pivot", ["写入前要不要审", "老的要不要清掉"], embed);
    } finally {
      Date.now = realNow;
    }
    expect((await readRows(dbPath, "mem-A")).map((r) => r.text)).toEqual(["写入前要不要审", "老的要不要清掉"]);
  });
});
