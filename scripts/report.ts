import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readReportSnapshot, renderReport } from '../src/server/report.ts';

const args = process.argv.slice(2);
try {
  let dataDir = join(homedir(), '.phantom');
  let explain = false;
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      `Usage: npm run report -- [--data-dir <directory>] [--explain]
默认数据目录：home .phantom；--data-dir=<directory> 亦可。不回退到 checkout-local 数据。
--explain 显示报告开头的统计口径说明，可与 --data-dir 组合。
直接 readOnly 读取 phantom.sqlite；不依赖宿主运行，不迁移、不获取 ownership 锁。
SQLite 正常管理 -wal/-shm；短 deferred 快照后关闭连接再聚合。数据库忙立即失败，无重试。
缺失路径/主库、损坏数据或不支持的结构返回非零退出码；不创建主库或目录，不输出半份报告。

口径（所有关联限定同一 Project）：
  合并数：持久 done merge-pr operation 的 Task/revision/PR/Repo 身份一致，按 Task ID 去重。
  普通 done、mergeApproval、聊天、completionSyncedAt 不证明实际合并；历史 done 未确认单列。
  无干预率：确认无干预 Task / 全部确认合并 Task；零分母 N/A。
  消息：仅 user 的 discuss/feedback，按同 Project 持久 source/Run Task 关联或明确完整 Task ID、
  唯一 #Issue、仓库身份一致的 Issue URL；共享原始来源不扩散，原始实施请求排除，消息 ID 对每 Task 去重。
  时间窗：Task.createdAt（本地发布边界）≤证据时间≤实际 merged_at；消息和 Task 缺失时间不回退 updatedAt。
  Incident：明确 user/http_incident 处置，或最终 waiting_user 且满足
  Task.createdAt≤Incident.createdAt≤Incident.updatedAt≤merged_at，均按 Incident ID 去重。
  Incident.updatedAt 仅为最终状态成立的时间上界；晚于合并、缺失或矛盾时间单列缺口。
  创建/评估时间或普通暂停本身不能反推合并前等待用户。
  resolved、原因文本和 PM/on-call 内部处置均不推定用户参与；后续内部处置不抹去早先用户证据。
  产品 Clarification 保留含发布前的 Task/原始来源关联；answered/cancelled 仍为证据。
  暂停/恢复/取消事件须有有效 control.action/source/reason 且 action 一致：user 计干预，host/pm 不计。
  同次 Incident 处置控制只计事故，独立用户控制仍按 Event ID 计暂停/恢复/取消。
  缺失、未知枚举、无效或不一致来源继续 unknown；关联不清单列未归属，不按原因文本或 pausedByUser 猜来源。
  recovery.pauseProvenance=user 无原动作 ID 时仅计用户暂停记录；已有用户暂停则补充证据，不增加次数，
  无法判定是否另一次暂停。缺失来源和时间保留缺口，旧数据不回填。
  Task 干预=无表示未发现已确认干预证据。当前无历史完整性标记，此类样本仍为未知，比例为保守下界。
  Incident：Project 全部记录，按 ID 去重、原始 phase 分组，缺 phase 为 unknown。
  watchdog：type=watchdog Event 或 Run/Incident 的宿主 Watchdog：失败前缀/descriptor detail，按 Run ID 去重；
  无 Run ID 的触发证据另列，一般失败不计。返工仅汇总每个 Task 的持久 retries，缺失不补零。
  token：先汇总每个确认合并 Task 全部可归属 Run，再对完整 Task 总量取中位数。
  包含失败/恢复/Dev/Review/明确归属 PM；最终 usage.totalTokens 优先，否则 inclusive input+output，
  cache/reasoning 为子集不再相加；缺失/非 final 为 unknown/partial。
  PM 优先直接 Task 或关联 Incident；原始 source 唯一对应一个 Task 才归属，否则未分配且候选 Task partial。
  墙钟交付耗时：Task createdAt 到持久实际 merged_at，不用 updatedAt/交接时间或 Run 执行时长替代。
  团队说明版本：确认合并 Task 按合并前全部 Run 固定的版本分组；跨版本另列，缺版本/时间列未记录。
  观测无干预合并率（按现有持久归因）：未发现 taskInterruptions 归因干预的确认合并数/该版本确认合并数。
  这只衡量已记录行为，不证明绝对无人介入；各组列已发现干预、明确关联的归因不明数，并保留未覆盖/漏记提示。
  原总体无干预率保守下界不变；合并少于 5 个只显示样本数，避免单个 Task 带来至少 20 个百分点的波动。
  团队采用的做法：仅所有固定版本都沿用做法的 Task 计样本；复盘同类且引用实际归因打扰才列未见效。
  恢复继承目标版本的做法，恢复回来可重新生效；编辑其修改节后不再推定沿用。失败/未完成/no_rule 列未分类，
  无归因证据列覆盖未知；模型类别不能单独证明打扰发生。
  token/耗时独立展示有效 n/确认合并总数及缺失样本；合法零保留，偶数取中间两值平均，无样本 N/A。
报告仅输出文本，不请求 GitHub/模型，不写日志、临时副本或持久报表。`,
    );
  } else {
    let hasDataDir = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--explain' && !explain) explain = true;
      else if (
        arg === '--data-dir' &&
        !hasDataDir &&
        args[i + 1] &&
        !args[i + 1].startsWith('--')
      ) {
        dataDir = args[++i];
        hasDataDir = true;
      } else if (arg.startsWith('--data-dir=') && arg.slice(11) && !hasDataDir) {
        dataDir = arg.slice(11);
        hasDataDir = true;
      } else throw new Error('用法：npm run report -- [--data-dir <directory>] [--explain]');
    }
    const snapshot = readReportSnapshot(resolve(dataDir));
    process.stdout.write(renderReport(snapshot, { explain }));
  }
} catch (error) {
  console.error(`报告失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
