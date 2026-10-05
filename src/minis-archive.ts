/**
 * Minis 对话入库后的存档。
 *
 * 投递目录（config.sources.minis.path，iCloud 桌面上的 minis-outbox/ingest）里的 jsonl
 * 一旦入库，就挪进 data/minis-archive：
 * - 投递目录空了 = 都收到了。文件堆在桌面上时分不清哪些处理过（2026-09-11 Alice：「不然我会搞糊涂的」）。
 * - 存档目录由 Deja 统一树读取（refresh-conversation-truth.py 的 claude 组，分组名 minis），
 *   原文因此能在 Deja 里找到；recallnest 的 ingest 源清单里没有这个目录，
 *   所以记忆库只收投递目录那一次，挂 minis: 前缀。
 *
 * 先复制、逐字节核对，再删原件，不直接 rename：投递目录是 iCloud 容器，
 * 把文件 rename 到容器外实测会让它直接消失（2026-08-20 踩过，见 minis-inbox/00-KEEP-收工时导出对话.md）。
 * 原件删掉后的副本就是存档本身（每日 restic 备份覆盖 ~/recallnest/data）。
 *
 * 只挪「台账里记着、大小和 mtime 都没变、且至少有一行可用对话」的文件：
 * 还没入库的、入库后又被同名覆盖的留给下一轮；格式不合规的留在原处报错。
 * 注意台账在某个 embedding 批次报错时也会记成已处理（ingestCCTranscripts 的既有行为），
 * 那种文件同样会被挪走——原文在存档里，要补导就从存档拷回投递目录。
 *
 * 2026-10-06 起对话原文默认不再入库（env-config.ts `transcriptIngest`），上面说的「入库」这一步默认不跑：
 * cli.ts 这时传进来的 `isIngested` 是 `settledCheck()`（文件至少 60 秒没被改过），于是规则变成
 * 「放稳了、整个文件写完了（`isCompleteJsonl`）、且至少有一行可用对话的就挪」，其余不变
 * （同名不同内容另存 -2、格式不合规的留在原处报错、先复制核对再删原件）。记忆库不再收 Minis 的对话，
 * Deja 照旧从存档读。把入库重新打开（RECALLNEST_TRANSCRIPT_INGEST=on）就回到上面那套按台账挪的规则。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

export interface MinisArchiveResult {
  /** 已挪进存档的目标路径 */
  archived: string[];
  /** 还没入库（或入库后又变了）的文件名，留在投递目录等下一轮 */
  pending: string[];
  /** 出错、原件留在原处的文件名和原因 */
  errors: string[];
}

export type IngestedCheck = (filePath: string, size: number, mtimeMs: number) => boolean;

/** 对话入库关着时，文件至少这么久没被改过才挪（毫秒） */
export const MINIS_SETTLE_MS = 60_000;

/**
 * 对话入库关着时用的判据：文件已经至少 quietMs 没被改过。
 * 入库开着的时候，一个文件要先被整个读完、切片、嵌入、记进台账，之后大小和 mtime 都没变才会被挪——
 * 这段时间等于一个隐含的静置期，正在写的文件过不了。关掉入库后这段时间没有了，这里把它显式补回来：
 * 刚落地、可能还在写或还在同步的文件留给下一轮（下一轮它的 mtime 自然就够老了）。
 */
export function settledCheck(quietMs: number = MINIS_SETTLE_MS, now: () => number = Date.now): IngestedCheck {
  return (_filePath, _size, mtimeMs) => now() - mtimeMs >= quietMs;
}

/** 同名但内容不同（同一场对话后来又导出过一版）时另起 -2、-3，两版都留着；内容相同就复用。 */
function pickTarget(archiveDir: string, name: string, bytes: Buffer): { path: string; alreadyThere: boolean } {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = join(archiveDir, n === 1 ? name : `${stem}-${n}${ext}`);
    if (!existsSync(candidate)) return { path: candidate, alreadyThere: false };
    if (readFileSync(candidate).equals(bytes)) return { path: candidate, alreadyThere: true };
  }
}

/**
 * 一个 jsonl 是不是写完了：以换行结尾，且每个非空行都解析得出 JSON。
 * 对话入库关着时挪存档之前用它把关——解析对话的函数会跳过残缺行，一个只写了一半的文件照样「有可用的对话行」，
 * 不看这一条的话，半截文件会被当成完整的收走、原件删掉。读不了（比如 iCloud 占位文件）时照旧抛错，由调用方记进 errors。
 */
export function isCompleteJsonl(filePath: string): boolean {
  const text = readFileSync(filePath, "utf-8");
  if (!text.endsWith("\n")) return false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { JSON.parse(line); } catch { return false; }
  }
  return true;
}

export function archiveIngestedMinisFiles(
  dropDir: string,
  archiveDir: string,
  isIngested: IngestedCheck,
  hasConversation: (filePath: string) => boolean = () => true,
): MinisArchiveResult {
  const result: MinisArchiveResult = { archived: [], pending: [], errors: [] };
  if (!existsSync(dropDir)) return result;

  const names = readdirSync(dropDir).filter((f) => f.endsWith(".jsonl")).sort();
  for (const name of names) {
    const source = join(dropDir, name);
    try {
      const before = statSync(source);
      if (!before.isFile() || !isIngested(source, before.size, before.mtimeMs)) {
        result.pending.push(name);
        continue;
      }

      // 一行可用对话都没有的文件，台账也会记成已处理（0 chunks）。这种不收走，留在投递目录报错：
      // 悄悄挪走的话，Minis 导出格式哪天变了，谁都看不见
      if (!hasConversation(source)) {
        result.errors.push(`${name}: 没有可用的对话行（格式不合规或还没写完），留在原处`);
        continue;
      }

      // iCloud 占位文件（dataless）在这里会抛 EDEADLK，原件不动，下一轮再来
      const bytes = readFileSync(source);
      if (bytes.length !== before.size) {
        result.errors.push(`${name}: 读取时文件在变（${before.size} → ${bytes.length} 字节）`);
        continue;
      }

      mkdirSync(archiveDir, { recursive: true });
      const target = pickTarget(archiveDir, name, bytes);
      if (!target.alreadyThere) {
        const partial = `${target.path}.partial`;
        // 沿用原件权限：Minis 写出来是 600，默认 umask 会把副本放宽成 644
        writeFileSync(partial, bytes, { mode: before.mode & 0o777 });
        renameSync(partial, target.path);
        // 存档沿用原件 mtime，Deja 里显示的时间才是对话时间而不是搬运时间
        utimesSync(target.path, before.atime, before.mtime);
        if (!readFileSync(target.path).equals(bytes)) {
          result.errors.push(`${name}: 存档回读与原件不一致，原件保留`);
          continue;
        }
      }

      // 复制期间原件被同名覆盖（Minis 又导出了一版）：不删，下一轮先把新版入库
      const after = statSync(source);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        result.pending.push(name);
        continue;
      }

      unlinkSync(source);
      result.archived.push(target.path);
    } catch (err) {
      result.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
