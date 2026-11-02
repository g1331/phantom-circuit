# Task #56 验收产物

本目录补齐 Secondary 提出的第 5、6、8 项证据缺口，文件随 Task 交给宿主提交，供只读 Review 直接读取。此次只补文档和原始产物，未修改应用实现、测试、依赖或构建配置。

产物生成时的源码候选为 **`a7270944b9e0aba776bfbf41f7bab077d9bf8123`**；对照 BASE 为 **`765f049a63fc01285d832fe74f711a5dc7c3f7e3`**。产物不是来自尚未生成的证据提交。宿主仍需将最终提交、正式检查及本目录共同绑定到 Review。

| 验收项 | 可直接读取的文件 | 来源 revision | 本次检查结果 |
| --- | --- | --- | --- |
| 6：同口径前后 chunk 大小 | [BASE 构建原文](base-build.txt)、[候选构建原文](candidate-build.txt)、[精确字节数与资产哈希](build-assets.json) | BASE `765f049…` → 候选 `a727094…` | 最大 JS 从 542.28 kB 降至 296.79 kB；BASE 有默认 500 kB 警告，候选无超限警告 |
| 5：生产懒加载请求 | [原始网络记录](maintenance-network.json)、[生产专项完整输出](production-browser.txt) | 候选 `a727094…` | 初始仅入口和 React 运行时；设置、详情在访问后请求；首次、再次打开及刷新入口断言通过 |
| 8：截图与实际视觉检查 | [逐组截图索引和检查记录](visual-inspection.md)、[原始 PNG](screenshots/) | 候选 `a727094…` | 32 张既有尺寸/语言/主题矩阵图及 5 张加载/错误图逐张查看；结果和截图边界见检查记录 |
| 5、6、8：revision 与文件完整性 | [源码与环境绑定](source-binding.json)、[SHA256 清单](sha256.json) | 同上 | 导出输入逐文件核对 Git blob，文本比较时规范化 Windows CRLF；网络脚本对应候选资产；清单覆盖本目录除清单自身外的全部文件 |

## 相同构建口径

两个 revision 的构建输入经只读 `git archive` 导出到当前 Task 的 `.cache/task56-review-evidence/base` 和 `head`，未切换分支、创建其他 worktree 或修改 Git 元数据。导出的路径为 `src`、`tests`、`scripts`、`index.html`、`vite.config.ts`、`tsconfig.json`、`package.json` 和 `package-lock.json`。本机现有 `core.autocrlf=true` 使导出的文本采用 CRLF；校验时仅将这些文本的 CRLF 规范化为 LF，再逐文件与对应 Git blob 核对，其他差异不接受。实际用于构建的导出文件未被修改，两边使用相同规则；数量及校验方式见绑定 JSON。

两份快照复用同一个已安装依赖目录，没有执行安装或升级。两个 revision 的 lockfile Git blob 均为 `cb92477c19a8efc8695ff7c88f402608bfecdfc9`；已安装 lockfile 中的 278 个包条目与 revision lockfile 及实际包 manifest 版本一致。未安装的平台可选包不计作已安装。详细摘要、校验数量和源码树摘要见 [source-binding.json](source-binding.json)。

环境为 Node `v24.19.0`、npm `11.17.0`、Vite `7.3.6`、TypeScript `5.9.3`。两个快照分别在自己的目录执行同一条命令，退出码均为 0：

```powershell
npm run build -- --configLoader runner
```

实际脚本为 `tsc --noEmit && vite build --configLoader runner`。`runner` 只用于绕过本沙箱默认 esbuild 配置加载的父目录读取限制；两边没有修改压缩设置或默认 500 kB 警告阈值。宿主的正式 `npm run build` 结果仍单独绑定到最终 revision，本目录的可比开发构建不替代正式检查。

| 产物 | BASE kB / gzip kB | 候选 kB / gzip kB |
| --- | ---: | ---: |
| 主入口 JS | 542.28 / 167.17 | 296.79 / 92.62 |
| React 静态共享运行时 JS | 包含在入口 | 221.85 / 69.04 |
| 设置面板 JS | 包含在入口 | 22.77 / 6.65 |
| 任务详情 JS | 包含在入口 | 4.29 / 1.55 |
| CSS | 55.27 / 11.15 | 55.27 / 11.15 |

表格采用 Vite 输出的十进制 kB 及四舍五入口径；[build-assets.json](build-assets.json) 同时保存文件字节数、以当前 Node 默认 gzip 计算的字节数及 SHA256。该对照证明单 chunk 大小变化，不推导总下载量减少或首屏性能提升。

## 当前候选与被评审版本的关系

Secondary 上次读取的 HEAD 为 `c0032f05495fa9ba035f7ec251c982f2ace609be`。它到本次候选 `a7270944…` 的实际差异只有 `prompts/review.md` 增加两行；上面列出的全部构建及测试输入一致，其 Git 输入清单 SHA256 都是 `848aee4a303db84c9d468403245744a05bd01a45d6280d6877f67220fb6adc33`。完整树本身不同，记录在 [source-binding.json](source-binding.json)，没有把本次产物标为旧 HEAD 生成。

## 生产浏览器与网络检查

在候选快照构建成功后，从同一快照目录运行：

```powershell
npx tsx scripts/maintenance-browser-check.ts
```

退出码为 0，使用全新 headless Edge 配置和内存 fixture，服务真实 `dist/` 于 `127.0.0.1:4333`。截图和网络记录来自这一次运行，没有拷入之前 `test-results/` 的旧截图。未启动用户宿主，未使用生产数据库或真实 GitHub 写入。

[maintenance-network.json](maintenance-network.json) 的 `initial` 只有 `index-CwDo2cpH.js` 与 `react-vendor-C9H2zL7m.js`。`accessed` 随后出现 `settings-panel-xvfgebtY.js` 和 `task-detail-BO5SfTSm.js`；全部请求脚本文件名都与 [build-assets.json](build-assets.json) 中的候选资产核对一致。记录后段还包含用例显式刷新页面产生的请求，不能将其误读为后台刷新反复下载面板。

首次设置打开被真实 chunk 请求 gate 暂停时，`role=status` 可见；放行后表单可用。再次打开设置的脚本请求数量不增加。详情在首次加载期间关闭重开可用；设置和详情分别在真实 chunk 请求失败后，重试或关闭重开都能恢复。用例还验证了后台 SSE 刷新时的表单草稿、原 DOM 焦点、详情滚动位置、现有项目设置入口，以及历史/当前故障的区别和跨项目处理区。上述时序行为由通过的浏览器断言支持；静态截图用于核对当时的可读性与布局。

## 完整性与交接

[sha256.json](sha256.json) 按文件原始字节计算 SHA256，覆盖本目录的构建原文、JSON、Markdown、PNG 和 [.gitattributes](.gitattributes)，排除清单自身。本目录的 `* -text` 属性防止 Windows Git 在入库/检出证据时转换换行；证据清单不做 CRLF 规范化，与上文仅用于核对导出源码的换行处理不同。宿主提交后，应在最终只读评审 checkout 中再次按清单核对文件原始字节。

目录不包含导出的源码、`node_modules`、缓存、生产数据或压缩后的应用 JS。文档和产物交由宿主提交；提交前若再修改影响构建或浏览器行为的源码，应重新生成相应产物。源码摘要和本次成功专项都不替代最终固定 revision 的规定 Review 与正式验证。
