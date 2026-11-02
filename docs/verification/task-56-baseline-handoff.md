# Task #56 新基线交接

本记录承接用户 feedback `23871d55-fe34-45d4-9d6c-686245cffc52` 的执行交接修订，不修改产品 spec、十条验收、优先级或重试规则，不新建替代 Task。Dev 本轮只做只读核对和必要验证，没有 fetch、merge、stage、commit、push 或操作生产数据库。

## 已观察到的本地整合状态

- 检查时 Task HEAD：`2e7fd17d61657a8f051e2486c5e95488f2951c69`，父提交为保留实现 `af6ddfcb9e2ededbabefe068a7d7431efe21a9d0` 和宿主整合的 target base `9f5baa2d880df927701a6a39b0bba8858b6b82dd`。
- 用户要求保留的实现 `af6ddfcb9e2ededbabefe068a7d7431efe21a9d0` 是该 HEAD 的祖先；当前没有 `MERGE_HEAD` 或未解决冲突。
- 修复的完整 revision 为 `45ef27c98fc8e4ee3a308f9c3283efc57f0dfb7a`，已在当前 HEAD 与本地 `origin/master` 的历史中。
- 本地 `origin/master` 指向 `9f5baa2d880df927701a6a39b0bba8858b6b82dd`。本地 `master` 为 `a552b8418a03f892c741d0f2b97a41a0357301c3`，是 `origin/master` 的祖先，并非更先进的候选。

这些是只读本地引用与历史核对，不等于独立验证了实时远端 master。PM 已指示不必空等第二次协调；宿主应在下一次正式验证前，经正常远端同步/基线协调确认最新 master，再固定最终 head/base。Dev 没有自行采用本地旧 master。

## 等待修复已实际生效

直接读取当前源码并核对 `45ef27c` 的 diff，以下等待循环的最大轮数与每轮间隔已是 30 秒口径；原有完成/状态断言保留，没有在 Task 分支另加 timeout 或重试补丁。

| 位置 | 当前实际等待上限 |
| --- | --- |
| `tests/dev-fixture.ts` 的 `until` | 1200 × 25 ms = 30 s |
| `tests/finalization.test.ts` 的 fixture Run 等待 | 1500 × 20 ms = 30 s |
| 同文件的并发宿主提交等待 | 1500 × 20 ms = 30 s |
| `tests/host-publication-recovery.test.ts` 的 `cycle` | 3000 × 10 ms = 30 s |
| `tests/host-recovery.test.ts` 的 `cycle` | 3000 × 10 ms = 30 s |

用户提供的“并行 agent 测试负载下原等待窗口不足、单独运行通过”是本次交接的诊断来源。本轮不重复主仓库诊断，也不把存在该提交本身当作新 revision 的测试通过结论。

## 新增产品差异与必要验证

不能将本次基线笼统记为“仅测试等待修复”。相对保留的 `af6ddfcb…`，已整合的三个上游提交还包含：

- `3bab509…`：Task 创建时拒绝不完整的 `changeType` / `scope` / `summaryEn` 命名组合。
- `45ef27c…`：`Store.createIncident` 在 schema 校验前限制宿主生成的长 message/evidence，避免因长度超限丢失 Incident；同时修改上述测试等待窗口。
- `9f5baa2…`：允许 `revise_task` 在分支创建前补齐完整工程命名，已有分支时拒绝改名。

原采集版本 `a7270944b9e0aba776bfbf41f7bab077d9bf8123` 更早；从它到当前 HEAD 还可见已进入旧基线的服务端差异：成功的同阶段 Run 收敛相应操作 Incident、宿主 whitespace 修复回合、Git 读取网络重试/工作区协调，以及报告 CLI/module。它们不能被抹成测试改动。报告模块没有作为本 Task 的修改对象，也没有修改 #59 的实现或要求。

对 #56 的影响与验证范围：

- 长 Incident 文本处理可能影响故障落库及 API 记录保真，检查 `incident-settle`、API 和历史完成生命周期测试。
- 成功 Run 的 Incident 收敛、宿主提交与工作区协调影响真实运行/交接路径，检查完成、宿主恢复/发布恢复、Git 网络重试及 whitespace 修复回归。
- 命名组合的创建/修订行为使用相应命名与 `revise_task` 回归检查。
- 用户指定的 `legacy target base in MERGE_HEAD` finalization 用例单独运行，保留原用例与断言。

本轮 Dev 检查绑定上述 HEAD，未改动测试源码、断言或等待设置：

- `npm run check`：退出 0。
- `npx tsx --test tests/api.test.ts tests/completion.test.ts tests/incident-settle.test.ts tests/task-naming-create.test.ts`：45 项通过，0 失败、0 跳过，退出 0。覆盖历史任务的 API 原始记录、重复 tick/sync/重启不变性、现行证据失败仍可操作、Incident 同阶段收敛与命名创建校验。
- 首次较宽的针对性组合和单独 finalization 运行没有形成完整汇总，已停止。日志明确报告 `legacy target base in MERGE_HEAD is resolved by editing only before installation` 失败，以及 `uncommitted Dev work does not block integrating a moved base`、`resuming a finalize whose change fails git diff --check lets the next Dev Run fix it` 失败。不能将其中已输出的通过用例算成整组通过。
- 完整 `npm test` 已运行，但在多个失败之后由 Dev 主动停止，进程退出 1，没有最终计数汇总。日志中首个失败为 `first startup migrates only authoritative data and keeps the old directory as rollback source`；后续还有 data-root 迁移/租约、`diff-check-rework` 和 finalization 回归失败，包括指定的 legacy 用例。不能记为完整运行通过，也不推算最终通过/失败数。

保留的本轮本地日志（均在忽略目录，不提交或加入原证据 manifest）：

| 日志 | 内容与终止状态 |
| --- | --- |
| `.cache/task56-new-baseline-focused-cmd.txt` | 上述 45 项完成并汇总，退出 0 |
| `.cache/task56-new-baseline-targeted.txt` | 较宽针对性组合；出现上述两条 whitespace 回归失败，Dev 主动停止，无最终汇总，进程退出 1 |
| `.cache/task56-new-baseline-finalization.txt` | 单独指定 legacy 用例；报告失败，Dev 主动停止，无最终汇总，进程退出 1 |
| `.cache/task56-new-baseline-full-cmd.txt` | 原始完整 `npm test`；多个用例失败后 Dev 主动停止，无最终汇总，进程退出 1 |

这些日志保留了实际已输出内容；失败行之后未输出对应断言详情或错误堆栈，不能补写推断的原因。PM 已回读本轮结果并指示 Dev 到此收尾，不再增加补丁、开发阶段重跑或为补诊断重启已停止测试。PM 没有提供可解释这些失败的已核实宿主沙箱限制。

较宽组合运行期间，PowerShell 的简单命令也出现延迟返回；显式 `cmd.exe` 下类型检查及上述 45 项测试可完成。该观察不足以证明失败根因。本轮没有把失败归因于 30 秒窗口不足，没有再次放宽等待、增加重试、修改断言或重复执行用户已完成的主仓库诊断。临时本地日志留在忽略目录 `.cache/`，不加入原证据包。以上均为 Dev 本地检查；宿主的新固定 revision 正式结果仍须单独记录。

## 原采集证据的复用边界

[原证据索引](task-56/README.md)、[source-binding](task-56/source-binding.json)、[网络记录](task-56/maintenance-network.json)、截图、构建原文和 manifest 均保持原内容，没有再转换日志、重算清单或重做截图矩阵。本交接文件位于原清单目录之外，避免改动既有采集包。

只读 diff 核对显示，从原采集版本 `a7270944…` 到当前 HEAD，`src/web`、`src/shared`、`vite.config.ts`、`index.html`、`package-lock.json`、`tsconfig.json` 以及 `scripts/maintenance-browser-check.ts` 没有差异。`package.json` 的变化是增加报告 CLI script，依赖、原 build/check/test/browser 命令没有改变。因此原构建对照、前端网络请求与视觉截图仍可作为其原采集 revision 的证据；不把它们改标为当前 HEAD 的新采集结果。

服务端产品代码已有上述变化，旧浏览器或生命周期结果不替代新基线的正式验证。必要的服务端针对性验证与最终宿主完整检查共同覆盖这一差异；若最终同步又带来前端、构建或被测接口的实质变化，应报告具体影响并只补对应验证。

## 宿主收尾

宿主按正常路径确认最新远端 master、保留并整合既有 #56 实现，在新的固定 head/base 上执行原始 `npm test`、`npm run check`、`npm run build`、`npm run test:browser` 和 complex 策略规定 Review。依 PM 本轮指导，宿主执行一次正式验证流程；若 `npm test` 再次失败，保留完整结果并暂停，后续 `&&` 命令未执行则如实记录。旧失败、测试及 Review 保留历史，但不代替新 revision 结论。用户已更新此前 Incident `16e0c16c` 的等待诊断口径；其回读、状态处理与正式交接由 PM/宿主负责，Dev 没有直接修改 Incident。

本轮没有重新执行 build 或浏览器矩阵，没有生成新截图、网络记录或重算旧采集文件。可交付的是保留的产品实现、原采集证据及本基线交接说明；当前新基线尚未通过完整验证，45 项通过不替代全量结果或规定 Review。
