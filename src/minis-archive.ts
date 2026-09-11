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
        result.errors.push(`${name}: 没有可用的对话行（格式不合规），留在原处`);
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
