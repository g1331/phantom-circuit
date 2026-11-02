import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readReportSnapshot, renderReport } from '../src/server/report.ts';

const args = process.argv.slice(2);
try {
  let dataDir = join(homedir(), '.phantom');
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      `Usage: npm run report -- [--data-dir <directory>]
默认数据目录：home .phantom；--data-dir=<directory> 亦可。不回退到 checkout-local 数据。
直接 readOnly 读取 phantom.sqlite；不依赖宿主运行，不迁移、不获取 ownership 锁。
SQLite 正常管理 -wal/-shm；短 deferred 快照后关闭连接再聚合。数据库忙立即失败，无重试。
缺失路径/主库、损坏数据或不支持的结构返回非零退出码；不创建主库或目录，不输出半份报告。

口径（所有关联限定同一 Project）：
  合并数：持久 done merge-pr operation 的 Task/revision/PR/Repo 身份一致，按 Task ID 去重。
  普通 done、mergeApproval、聊天、completionSyncedAt 不证明实际合并；历史 done 未确认单列。
  无干预率：确认无干预 Task / 全部确认合并 Task；零分母 N/A。
  合并前 Incident（含 resolved）、产品 Clarification（含 answered/cancelled，按 Task 和原始来源，含发布前）、
  有明确用户来源的暂停/恢复均为干预；自动恢复不算用户操作，无 actor 的历史动作来源 unknown。
  当前无历史完整性标记，未发现干预不证明无干预，未知单列，比例明确为保守下界。
  Incident：Project 全部记录，按 ID 去重、原始 phase 分组，缺 phase 为 unknown。
  watchdog：type=watchdog Event 或 Run/Incident 的宿主 Watchdog：失败前缀/descriptor detail，按 Run ID 去重；
  无 Run ID 的触发证据另列，一般失败不计。返工仅汇总每个 Task 的持久 retries，缺失不补零。
  token：先汇总每个确认合并 Task 全部可归属 Run，再对完整 Task 总量取中位数。
  包含失败/恢复/Dev/Review/明确归属 PM；最终 usage.totalTokens 优先，否则 inclusive input+output，
  cache/reasoning 为子集不再相加；缺失/非 final 为 unknown/partial。
  PM 优先直接 Task 或关联 Incident；原始 source 唯一对应一个 Task 才归属，否则未分配且候选 Task partial。
  墙钟交付耗时：Task createdAt 到持久实际 merged_at，不用 updatedAt/交接时间或 Run 执行时长替代。
  token/耗时独立展示有效 n/确认合并总数及缺失样本；合法零保留，偶数取中间两值平均，无样本 N/A。
报告仅输出文本，不请求 GitHub/模型，不写日志、临时副本或持久报表。`,
    );
  } else {
    if (args.length) {
      if (args.length === 2 && args[0] === '--data-dir' && args[1] && !args[1].startsWith('--'))
        dataDir = args[1];
      else if (args.length === 1 && args[0].startsWith('--data-dir=') && args[0].slice(11))
        dataDir = args[0].slice(11);
      else throw new Error('用法：npm run report -- [--data-dir <directory>]');
    }
    const snapshot = readReportSnapshot(resolve(dataDir));
    process.stdout.write(renderReport(snapshot));
  }
} catch (error) {
  console.error(`报告失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
