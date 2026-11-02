# npm test 性能测量（#61）

状态：基线验证受阻，需要宿主协助；测量工具已准备，优化尚未开始，尚未证明 50% 目标。
初始 HEAD 为 `1e68ba254c9c21e98655cfb00882434fd1cd4c78`，启动检查时工作区无改动。
正式对照和最终固定版本验证由宿主完成。

## 采集方法

在被测 worktree 中运行以下命令。采集脚本可以位于另一个目录，因而无需改动固定的基线源码。
每次使用一个不存在的、位于源码 worktree 外的证据目录，避免覆盖已有采样。

```powershell
$collector = 'C:\path\to\task-worktree\scripts\measure-tests.ps1'
pwsh -NoProfile -File $collector `
  -OutputDirectory 'C:\path\to\evidence\baseline-normal-1' `
  -LoadDescription '填写实际并行负载与本次资源限制' `
  -CacheDescription '填写预热、依赖安装和缓存处理方式'
```

默认模式执行原始 `npm test`，不传入额外测试参数。使用单调 Stopwatch，从启动命令前
计到命令退出且重定向结束后；等待 fixture、测试和正常清理结束，不强制退出。
`output.log` 保留完整输出，`metadata.json` 保存实际 revision、工作区状态、工具版本、
锁文件和采集脚本哈希、机器信息、可观察进程快照、墙钟和测试退出码。
测试非零退出会传递给调用方；采集错误也会报错，不能当成功样本。是否完整成功还需核对日志中的
最终 tests/pass/fail/skipped/cancelled/todo 汇总，不能只检查 metadata 文件存在。

用另一个证据目录，增加 `-Profile` 进行额外热点采集。它直接调用当前 worktree 安装的 tsx，
保持 `--test tests/*.test.ts` 的发现范围及默认调度，同时加载 spec 和观察用 reporter。
实际 argv 和 reporter 哈希均记录在 metadata 中。`timings.jsonl` 包含：

- `scope=file`：Node `test:summary` 报告的文件历时、结果及计数。
- `scope=run`：运行器的全量汇总。
- `scope=case`：用例完成事件、源码位置、耗时及 skip/todo 状态。
- `scope=suite`：suite 完成事件，不能重复计为叶子用例。

以下命令列出至少五个最慢文件和十个最慢用例（不足则列出全部）：

```powershell
$timings = Get-Content 'C:\path\to\evidence\baseline-profile\timings.jsonl' | ConvertFrom-Json
$timings | Where-Object scope -eq 'file' |
  Sort-Object duration_ms -Descending | Select-Object -First 5 file,duration_ms,success,counts
$timings | Where-Object { $_.scope -eq 'case' -and !$_.skip -and !$_.todo } |
  Sort-Object duration_ms -Descending | Select-Object -First 10 file,line,name,type,duration_ms
```

文件历时与用例耗时之和、运行器全量耗时、外层墙钟是不同指标。50% 验收只使用原始命令的完整
成功运行墙钟，profiling 不混入正式性能样本。所有失败和未完成运行也保留，单独标明原因。
脚本不会采集完整环境变量或进程命令行；NODE_OPTIONS 只记录是否存在，实际相关选项需脱敏补记。
原始日志和采集产物留在外部证据目录，发布前核查脱敏，不将日志提交到仓库。

## 对照与稳定性要求

宿主固定同场景的 base/head，在同机、同工具和依赖、匹配负载及预热/缓存条件下，成对或交替
各完成至少三次原始 `npm test`。逐次保留耗时、全部计数、退出码、实际 revision 和命令；
用完整成功运行的中位数计算候选/基线，必须不大于 0.50。若共同测试集改变，重新固定共同基线。
采集时脚本尚未提交，应使用记录的文件哈希关联，不能将旧日志改标为后来的提交。

另对 base/head 分别做匹配的单核或等效 CPU 受限验证，以及两份独立全量同时运行验证。
资源限制仅作用于本轮测试进程及其子进程；由宿主记录实际约束、各进程开始/结束时间、
结果、耗时和清理情况。两份运行分别保存证据，不能把轻载候选与重载基线比较。
采集脚本不会修改宿主、项目或仓库并发设置，也不会临时切换候选调度。

## 当前实现与隔离边界

目前只新增测量辅助脚本。`package.json` 测试入口和测试源码、断言、等待上限、fixture、
Git/HTTP/SQLite/Engine 的真实执行及清理均未改动；未新增依赖或扩大跳过条件。
观察用 reporter 只消费运行器事件，不启动测试、不缓存结果、不重试、不改变退出结果。
每次采集创建独立证据目录；被测套件的可变状态隔离仍由原有 fixture 保持。

现有显式可选跳过规则：`data-directory.test.ts` 的 Windows junction 场景仅在非 Windows 跳过；
`omp.test.ts` 的真实 OMP 探测按原有 `PHANTOM_RUN_OMP_PROBE` 开关跳过。具体执行结果以各次日志为准。

## 测量结果

2026-11-02 经 PM 同意，在 Dev 沙箱尝试一次原始 `npm test`。被测测试源码及入口未修改，
本次运行期间仅新增采集脚本和本文档，并执行了短时探针和类型检查。该负载条件不替代宿主正式匹配采样。

| 项目 | 实际记录 |
| --- | --- |
| revision | `1e68ba254c9c21e98655cfb00882434fd1cd4c78` |
| 系统 / CPU | Windows 11 Pro，10.0.26300，x64；i5-13600KF；20 逻辑核，Node 报告可用并行度 20 |
| 工具 | Node v24.19.0；npm 11.17.0；Git 2.45.2.windows.1；tsx 4.23.13 |
| package-lock.json SHA-256 | `CA08A67F5765618DF1CFB96431B6C0BC6415DFF1FBC47461D9D8D7CEF5ABDA3E` |
| 命令 / 发现 | `npm test` → `tsx --test tests/*.test.ts`；静态发现 44 个文件，最终用例数未知 |
| 预热 / 缓存 | 使用已有 node_modules 和当前缓存；未额外安装、清空缓存或预热 |
| 其他负载 | 可观察到其他 Node/Git/PowerShell 进程；其完整归属及负载未知 |
| 开始 / 最后可见日志 | 约 22:25 开始；日志最后更新于 22:37:50（UTC+08:00） |
| 状态 / 墙钟 / 最终计数 / 退出码 | 已出现失败标记；观察时仍未退出，未取得完整汇总，均不能填作成功样本 |

分别确认了三项事实，尚未查明它们之间是否存在因果关系：

1. `lifecycle.test.ts` 的 `real worktrees complete complex through pinned Provider routing, review, rework and merge`
   出现失败标记，运行器报告用例耗时 `21327.4133ms`。已出现失败标记，详细诊断尚未取得；
   完整断言、堆栈及最终错误汇总未出现在当前日志中。此前三个 route 的同类用例输出通过。
2. 日志持续没有新输出。最后一条可见输出为 `a re-affirmation that loses the race never cites a grant that is gone`，
   不能据此认定该用例或其文件就是停滞原因。
3. 为识别本轮测试后代而调用 `Get-CimInstance Win32_Process` 时得到“拒绝访问”。
   Dev 未绕过 ACL、批量终止进程或启动第二份全量叠加现场。

原始日志：`C:\Users\admin\AppData\Local\Temp\phantom-61-baseline-1e68ba2-dev-20261102.log`。
命令工具 session：`88281`。这次初始命令使用外层 Stopwatch 和 `npm test *> 日志路径`，
只有在命令退出后才会写出同名 `.log.json`，当前尚未产生该文件。

在 `2026-11-02T14:42:05Z` 保存的未完成日志快照为
`C:\Users\admin\AppData\Local\Temp\phantom-61-incomplete-20261102T144205Z.log`，
SHA-256：`14E8140EB427F41C6043C6C6AA1FC38717E6A91F1038B4B165ABC3B5E5EF3475`。
这是未汇总的诊断快照，不是成功基线；不据此推算通过率、完整墙钟或最终热点排名。

尚无可用于验收的成功基线、候选或匹配稳定性结果。完整前后结果表、至少五个文件和十个用例的
热点对照及优化依据待实际采集后补齐；用户描述的 7–10 分钟或约 370 个用例不作为实测值。

## 本轮交接与针对性验证

PM 已要求按“基线验证受阻、需要宿主协助”交回，不作为实现完成进入交付验证，也不原样重发 Dev 重跑。
宿主先关联本 Task、Dev Run、session、命令和工作目录保存执行记录；通过执行器的进程归属记录受控取消
本次会话，只清理能证明属于本轮的后代。不能按进程名称或最后日志内容猜测归属。
清理确认后，在上述固定基线执行一次原始 `npm test`；若同样失败，保留完整诊断并定位首个具体失败，
不循环重跑。若成功，补取热点并继续本 Task 的优化和匹配测量。当前 PM 无独立的命令取消、清理或启动入口，
尚未实际触发这些宿主动作。

本轮已通过 `npm run check`、PowerShell 语法解析、reporter 的 `node --check`。
外部临时小套件验证了通过、显式跳过、失败非零退出、异步 after 清理及 suite/叶子用例区分。
失败探针首次暴露 Windows reporter 绝对路径需使用文件 URL，修正后原探针通过；
正常探针取得 success=true、1 个用例和 1 个 suite。临时探针和日志不进入仓库。
另用当前安装的 tsx 对 `tests/task-naming.test.ts` 做 reporter 集成验证：3 个用例全通过，
取得文件和全量汇总；这是辅助工具的针对性验证，不计作完整性能采样。

宿主最终仍需在固定 head/base 执行 `npm test`、`npm run check`、`npm run build`、
`npm run test:browser`，按 complex 策略完成 Review 和交接；测量脚本不能替代这些验证。
