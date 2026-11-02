# Task #56 生产截图与视觉检查

来源源码：`a7270944b9e0aba776bfbf41f7bab077d9bf8123`。本次在该 revision 的导出快照中构建并运行生产专项，生成时间、构建输入摘要及执行结果见 [source-binding.json](source-binding.json) 和 [production-browser.txt](production-browser.txt)。截图是这一次运行的原始 PNG，未裁切、标注或修改像素。

检查者为本 Task Dev，检查日期为 2026-11-02。本轮使用图像查看工具逐张打开下列 37 张图，检查了文字、布局、历史/当前故障的视觉区别、窄屏边界和加载/失败反馈；这些是本地自检结果，不代表 Secondary 已验收。

## 常态矩阵：32 张

每行的四个链接都已查看；文件名中的 `history` 表示已打开历史 Task 详情。桌面为 1440×1000，窄屏为 390×844，均为 device scale factor 1。结果如下：

| 尺寸、语言、主题 | 看板 | 列表 | 历史详情 | 设置 | 观察结果 |
| --- | --- | --- | --- | --- | --- |
| 1440，英文，浅色 | [PNG](screenshots/maintenance-board-1440-en-light.png) | [PNG](screenshots/maintenance-list-1440-en-light.png) | [PNG](screenshots/maintenance-history-1440-en-light.png) | [PNG](screenshots/maintenance-settings-1440-en-light.png) | 已查看：标签、字段和历史说明可读；历史行无警告，真实故障保留红色原因/暂停状态；模态框与关闭入口清楚 |
| 1440，英文，深色 | [PNG](screenshots/maintenance-board-1440-en-dark.png) | [PNG](screenshots/maintenance-list-1440-en-dark.png) | [PNG](screenshots/maintenance-history-1440-en-dark.png) | [PNG](screenshots/maintenance-settings-1440-en-dark.png) | 已查看：正文、次要文本、故障色和表单边界可区分；历史说明与 Incident 原始状态没有警告样式 |
| 1440，中文，浅色 | [PNG](screenshots/maintenance-board-1440-zh-CN-light.png) | [PNG](screenshots/maintenance-list-1440-zh-CN-light.png) | [PNG](screenshots/maintenance-history-1440-zh-CN-light.png) | [PNG](screenshots/maintenance-settings-1440-zh-CN-light.png) | 已查看：中文导航、筛选、历史 Incident 标题和设置字段显示完整，未见相互覆盖 |
| 1440，中文，深色 | [PNG](screenshots/maintenance-board-1440-zh-CN-dark.png) | [PNG](screenshots/maintenance-list-1440-zh-CN-dark.png) | [PNG](screenshots/maintenance-history-1440-zh-CN-dark.png) | [PNG](screenshots/maintenance-settings-1440-zh-CN-dark.png) | 已查看：深色下正文与控件仍可读，历史完成卡片保持完成色，当前验证失败与 GitHub 漂移仍有红色提示 |
| 390，英文，浅色 | [PNG](screenshots/maintenance-board-390-en-light.png) | [PNG](screenshots/maintenance-list-390-en-light.png) | [PNG](screenshots/maintenance-history-390-en-light.png) | [PNG](screenshots/maintenance-settings-390-en-light.png) | 已查看：筛选工具栏换行；历史说明和原因自然折行；设置按钮/字段在模态框内，未见全页横向越界 |
| 390，英文，深色 | [PNG](screenshots/maintenance-board-390-en-dark.png) | [PNG](screenshots/maintenance-list-390-en-dark.png) | [PNG](screenshots/maintenance-history-390-en-dark.png) | [PNG](screenshots/maintenance-settings-390-en-dark.png) | 已查看：窄屏深色文本与控件可辨，Incident id、原始状态和 PR 按钮可见；历史卡片无旧干预徽标 |
| 390，中文，浅色 | [PNG](screenshots/maintenance-board-390-zh-CN-light.png) | [PNG](screenshots/maintenance-list-390-zh-CN-light.png) | [PNG](screenshots/maintenance-history-390-zh-CN-light.png) | [PNG](screenshots/maintenance-settings-390-zh-CN-light.png) | 已查看：中文筛选分行、详情原因折行、设置两列角色按钮均未覆盖邻项；关闭入口可见 |
| 390，中文，深色 | [PNG](screenshots/maintenance-board-390-zh-CN-dark.png) | [PNG](screenshots/maintenance-list-390-zh-CN-dark.png) | [PNG](screenshots/maintenance-history-390-zh-CN-dark.png) | [PNG](screenshots/maintenance-settings-390-zh-CN-dark.png) | 已查看：历史说明/原始 Incident 状态可读且无红色警告；同屏的当前故障仍有红色提示；设置内容保持在模态框内 |

截图观察的具体边界：

- 看板截图按既有内部横向滚动定位到完成列，邻列在容器边界处裁切属于该滚动视图；没有据此声称全部阶段同时可见。
- 窄屏列表沿用既有省略号规则，部分长标题和原因在行内被省略，完整内容通过详情查看；当前验证失败仍保留暂停状态。检查结论不是“窄屏列表能完整显示所有长文本”。
- 历史详情截图已在模态框内部滚动到历史说明区域，展示原始原因、Incident id 和原始 Open/待处理状态。原始状态被放在明确的历史说明下，不要求用户恢复或处理。PR 按钮在窄屏截图可见；桌面截图中其位置可能在下方，浏览器用例另行核对了链接 href。Incident 完整 JSON 的展开及内容等于原始记录也由同一用例核对。
- 设置截图展示顶部表单及角色分配；更下方的字段通过模态框内部滚动访问。标题、语言控件和关闭入口均未被新内容遮挡。
- 英文界面中的原始中文故障原因、合成 Task 标题、routing reason 和模型 id 是保留的记录内容，不能把它们误算为本轮 UI 字符串翻译缺失。

## 加载与错误反馈：5 张

这些沿用现有专项的桌面英文浅色场景，没有另扩展错误状态的尺寸/语言/主题矩阵。

| 状态 | 原始截图 | 视觉观察 | 对应时序断言 |
| --- | --- | --- | --- |
| 首次设置模块延迟 | [Loading](screenshots/maintenance-loading.png) | 模态框保留标题、语言和关闭入口；正文可见 Loading panel…，没有空白失去反馈 | gate 放行后设置表单可用；加载反馈通过 `role=status` 定位 |
| 设置加载失败，随后重试 | [Settings / retry](screenshots/maintenance-settings-panel-failed-retry.png) | 错误原因与 Try again 按钮可见，文字没有盖住按钮或关闭入口 | 真实 chunk 请求失败后 `role=alert` 可见；允许请求后重试恢复设置 |
| 设置加载失败，随后关闭重开 | [Settings / reopen](screenshots/maintenance-settings-panel-failed-reopen.png) | 与重试场景相同的可见错误反馈，没有无限 loading | 关闭并重开后恢复设置；不是重新创建整个应用 |
| 详情加载失败，随后重试 | [Detail / retry](screenshots/maintenance-task-detail-failed-retry.png) | Task 标题、错误文本、重试和关闭入口可读 | 允许请求后重试恢复历史详情 |
| 详情加载失败，随后关闭重开 | [Detail / reopen](screenshots/maintenance-task-detail-failed-reopen.png) | 同样保留明确错误与退出入口 | 关闭并重开后恢复历史详情 |

错误截图展示的是恢复动作之前的状态。恢复是否成功、后台刷新是否保留草稿/焦点/滚动位置、再次打开是否复用已加载模块，依据 [production-browser.txt](production-browser.txt) 所记录的通过断言，而非从一张静态图片推断。`retry` 和 `reopen` 两个场景的失败截图可能逐字节相同；它们仍来自各自的新页面和独立恢复用例。

## 网络与产物核对

[maintenance-network.json](maintenance-network.json) 初始只有入口与 React 共享运行时，未包含设置/详情模块。访问后记录中的四种脚本都能在 [build-assets.json](build-assets.json) 找到精确文件名、字节数及 SHA256。生产专项还断言了首次使用后再次打开设置不增加脚本请求，以及实际刷新入口、失败重试和关闭重开可用。

本记录支持本次产物的视觉与请求检查，不宣称测得首屏加速，也不替代宿主最终固定 revision 的完整浏览器套件或独立 Review。
