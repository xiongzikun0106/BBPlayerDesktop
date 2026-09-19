# BBPlayer Desktop（Electron）

Windows / Linux 桌面端。**Phase 0–5 已完成**：播放 / 搜索 / 歌单 / 歌词 / 登录同步 /
下载 / WebDAV 备份 / 媒体集成 / 独立歌词窗口 / 主题 / 定时关闭 / 响度均衡 /
播放历史 / 外部歌单导入 / 共享歌单，并且 Windows 与 Linux 的安装包均已构建并在真机验证。

未做的只有 Phase 5.3（代码签名）与 QQ 音乐的歌单导入（接口需要登录态签名）。

方案与阶段划分见 [`docs/DESKTOP_PLAN.md`](../../docs/DESKTOP_PLAN.md)。

---

## 快速开始

```bash
# 手动运行（开窗口）
pnpm --filter @bbplayer/desktop start
```

国内网络下载 Electron 二进制（首次安装需要，约 142 MB）：

```bash
ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ pnpm install
```

> Electron ≥ 42 移除了 `postinstall`，二进制是**懒下载**的 —— 所以刚装完
> `dist/` 是空的属于正常现象。实测走镜像约 24 s，直连约 50 min。

---

## 验证套件

全部验证都是**自动化的**，跑完自动退出；UI 类会用
`webContents.executeJavaScript` 做**点击级**操作并截图，报告落
`apps/desktop/probe-output/`。

```bash
# 根目录已加好脚本（推荐）
pnpm verify:desktop            # 18 项：真实播放 / seek / Range 透传
pnpm verify:desktop:ui         # 33 项：三栏 shell / 导入 / 播放 / 快捷键 / 搜索 / 歌词
pnpm verify:desktop:login      # 38 项：登录三条路 / 收藏夹 / 增量同步
pnpm verify:desktop:media      # 27 项：MediaSession / 任务栏按钮 / 媒体动作链路
pnpm verify:desktop:lyrics-win # 38 项：独立歌词窗口
pnpm verify:desktop:history    # 31 项：播放历史视图（记录 + 三个页签）
pnpm verify:desktop:import     # 25 项：外部歌单导入 UI（解析 / 匹配 / 导入落库）
pnpm verify:desktop:settings   # 50 项：设置页 / 主题 / 定时关闭 / 响度均衡
pnpm verify:desktop:icons      # 25 项：任务栏图标生成器
pnpm verify:desktop:download   # 34 项：下载 / 续传 / 完整性 / 并发
pnpm verify:packaged           # 24 项：打包产物自检（Windows / Linux）
pnpm verify:win-installer      # 12 项：Windows 安装包装/卸全程 + portable 启动（仅 Windows）
pnpm verify:backup             # 48 项：备份格式与移动端互通
pnpm verify:backup:webdav      # 28 项：真实回环 WebDAV 服务器
pnpm verify:login              # 52 项：登录接口与 RSA 加密链路
pnpm verify:play-history       # 35 项：播放历史 SQL 层
pnpm verify:external-import    # 65 项：外部歌单导入后端（含真实网易云歌单）
pnpm verify:sortkey            # 16 项：跨端歌单顺序互通（sort_key 方向）
pnpm verify:shared             # 95 项：共享歌单契约（**需要本机后端**，见下）
pnpm verify:desktop:shared     # UI 点击级：账号 / 订阅 / 分享 / 成员 / 邀请码（**需要本机后端**）

# 需要 tsx 的其它验证
pnpm exec tsx scripts/verify-core-on-node.mjs
pnpm exec tsx scripts/verify-bilibili-api.mts
pnpm exec tsx scripts/verify-lyrics.mts
pnpm exec tsx scripts/verify-desktop-db.mts
pnpm exec tsx scripts/verify-md5.mts
```

⚠️ **跑 Electron 类验证前先清掉遗留进程**，否则探针会静默失败：

```powershell
Get-Process -Name electron -ErrorAction SilentlyContinue | Stop-Process -Force
```

### 验证的边界（重要）

- **扫码登录的最后一跳需要真人用手机确认**，自动化到不了。因此
  `verify:desktop:login` 把这类项记为 **「待人工验证」**，既不算通过也不算
  失败，并在输出里显式列出 —— **不用「状态正确」掩盖「没验证」**。
  设置 `BILIBILI_TEST_COOKIE` 后，探针会额外自动验证登录后的行为。
- **系统媒体面板的呈现**（Windows 的 SMTC、Linux 的 MPRIS）无法从应用内部
  断言，需要看操作系统 UI。`verify:desktop:media` 断言的是应用**交给系统**的
  那份数据（标题 / 作者 / 封面 / 播放状态 / 进度）以及主进程侧的任务栏按钮
  与图标。

---

## 架构

```
apps/desktop/
  package.json
  drizzle/0000_baseline.sql   schema 基线（与移动端同源，见下）
  src/
    main.cjs                  主进程：特权协议、窗口、IPC、探针模式
    preload.cjs               contextBridge：只暴露必要能力
    ports.cjs                 端口实现（node:sqlite / 文件 KV / fetch / logger）
    core-loader.cjs           jiti 加载 core 的 TS/ESM
    db.cjs                    迁移运行器 + 歌单/曲目/远端来源映射
    audio-proxy.cjs           bvid 解析 + bbplayer-audio:// 代理
    bilibili-api.cjs          core 端口注入客户端 + WBI 签名
    bilibili-login.cjs        登录门面：扫码/密码/粘贴 + 凭据加密落盘
    bilibili-rsa.cjs          密码登录的 RSA 加密（动态 PEM 为主 + BigInt 兜底）
    bilibili-cookie.cjs       cookie 解析/校验（纯函数，便于离线验证）
    bilibili-login-holder.cjs 登录管理器持有者（打断循环依赖）
    download.cjs              下载：Range 续传 / 完整性校验 / 备用地址回退
    backup.cjs                备份格式（ZIP + SQLite 快照）+ 迁移表规范化
    backup-webdav.cjs         WebDAV 传输（复用 core 的平台无关客户端）
    backup-manager.cjs        配置持久化 + WebDAV 密码加密 + 编排
    lyrics-window.cjs         独立歌词窗口（无边框透明置顶）的主进程侧
    media-integration.cjs     任务栏缩略图按钮 + 硬件媒体键兜底
    thumbar-icons.cjs         32×32 PNG 图标运行时生成（零依赖）
    netease-playlist.cjs      网易云歌单抓取（匿名接口 + 字段裁剪）
    track-matcher.cjs         歌单匹配：权重打分 + 负向词罚分 + 落库
    bbplayer-account.cjs      BBPlayer 账号（共享歌单的后端身份；独立于 B 站登录）
    shared-playlist.cjs       共享歌单：分享 / 订阅 / outbox 增量同步 / 成员 / 邀请码
    ipc-handlers.cjs          全部 IPC handler
    theme.cjs                 设计令牌 → CSS 变量（含材质强度与种子色派生）
    探针：probe-driver / ui-probe-driver / ui-tour-driver / compare-driver /
          login-probe-driver / media-probe-driver / settings-probe-driver /
          lyrics-window-probe-driver / history-probe-driver / import-probe-driver /
          share-probe-driver
    renderer/
      index.html  style.css  components.css
      theme.js  components.js  status.js  state.js  player.js  library.js
      keyboard.js  lyrics-panel.js  media-session.js
      lyrics-window.html  lyrics-window.css  lyrics-window.js
      desktop-features.js  settings-panel.js
      auth.js  favorites.js  history.js  import.js  share.js  renderer.js
    renderer/assets/
      material-symbols-rounded.woff2   Material Symbols **子集**（65 个图标，10.6 KB）
      material-symbols.css  material-symbols.json
      ↑ 由 scripts/build-icon-font.mjs 生成，**随源码提交**（见下）
```

## 界面（阶段 0–6 重做）

完整施工图见 `docs/DESKTOP_UI_PLAN.md`（阶段 0–5）与
`docs/DESKTOP_UI_PLAN_STAGE6.md`（阶段 6：对齐安卓端交互），进展与踩坑见
`docs/DESKTOP_UI_PLAN_STAGE6_PROGRESS.md`。几条**会导致返工**的约定：

- **信息架构**：左栏只有 4 个**目的地**（主页 / 音乐库 / 搜索 / 设置）。
  「导入」「共享」是页内动作，不是一级入口。音乐库内部有 4 个页签
  （播放列表 / 收藏夹 / 合集 / 导入）。
- **中栏是互斥的多页面**：`#content` / `#view-share` / `#view-settings` /
  `#view-nowplaying` 四选一，由 `renderer.js` 的 `showMainPane()` **统一**决定
  谁可见。分散在各自模块里决定迟早会漏一个，而漏掉的表现是"某两个页面同时
  出现在屏幕上"。
- **标题只有一处**：外壳的 `#page-title`。视图内部**不要**再渲染同名标题
  （设置页与共享面板各踩过一次：出现两个一模一样的标题，而断言全绿）。
- **选中态只有一种**：填充胶囊，取 `secondary-container` / `on-secondary-container`。
  导航项、页签、分段控件共用同一组选择器。
- **封面统一圆角正方形**（用户明确要求），不用圆形。
- **`[hidden]` 必须真的隐藏**：`style.css` 顶部有一条全局
  `[hidden] { display: none !important }`。UA 的 `[hidden]` 优先级极低，
  任何 `display: flex` 都会盖掉它 —— 这个仓库为此绕过两次。
- **队列只有一份 DOM**（`#queue-list`），在右栏与正在播放面板之间搬运
  （`placeQueue()`）。渲染两份会让 `data-queue-index` 重复。

### 阶段 6：对齐安卓端交互（新增约定）

**方法论**：动手前先读 `apps/mobile`，产出「安卓端怎么做 → 桌面端怎么做 →
为什么（保留 / 因宽屏改变）」的对照。只在"鼠标 + 宽屏"确实要求不同的地方才改，
不因为"桌面软件通常这样"就发明新惯例 —— 阶段 0–5 的返工就是这么来的。

- **靠"面 + 留白"分层，不用通栏细线**。原来的问题和修法：分割线从 `.main`
  的 x=0 拉过去，而内容是内缩 16px 的，**线与字永远差 16px**。修法不是把线缩进
  （那还是直角的线），而是把每个功能区做成**卡片**（`--surface-container` +
  `--r-lg`）—— 卡片的边缘**就是**内容的内缩位置，不可能不齐。
  `#content` / `#view-settings` / `#view-share` 必须**同一张卡片面**。
  ⚠️ 只给其中一个做卡片会让某一页仍是"平铺一大片"，而截图上一眼可见。
- **卡片内的列表分隔用 `::before`，不要 `border-top`**。`border` 会横跨整行的
  左右内边距，视觉上又变回通栏线；只有 `::before` 能做到两侧都内缩到内容。
- **凡"样式写了却没生效"，先怀疑 CSS 特异性，再怀疑加载顺序**。这个项目被咬了
  三次：`.switch`(0-1-0) 被 `input[type='checkbox']`(0-1-1) 盖掉（全应用所有开关
  一起变成勾选框）；`.swatch` 被 `.settings-row button` 盖掉。
  解法是提特异性（`input[type='checkbox'].switch`），**不是**加 `!important`
  （后者会掩盖将来的同类冲突）。
- **菜单项不要设 `accelerator`**：Electron 在**菜单层**就把键吃掉了，渲染进程的
  `keys.register` 收不到 keydown（一次挂掉 4 条键盘断言）。快捷键写进**标签文字**
  保留可发现性即可。菜单项的文字写**动作名**（「播放 / 暂停」）而不是状态名
  （「暂停」）—— 菜单不随播放状态重建，写状态名会在播放时显示成错的。
- **菜单复用键盘的动作分发，不新写一套**：主进程只 `send(combo)`，
  渲染进程由 `bbKeys.trigger(combo)` 转交给**已注册的**处理器。
  同一功能有两条代码路径迟早不一致。
- **收藏夹/搜索/合集/分P 的同一个 id 不是同一个东西**（`aid` / `bv2av(bvid)` /
  `cid` / DB trackId）。凡涉及"选中集合"，键必须用 `uniqueKey`，用 `track.id`
  跨列表会**串味**。
- **行右侧是「⋮」而不是并排图标**（安卓端如此，桌面端照做）。关闭时机有**三条**：
  选中某项 / 点菜单外面 / 按 Esc —— 少一条就是"菜单关不掉"。
- **行内有 `width: 100%` 的输入框会被 flex 挤扁**（实测被压到 ~50px、文字硬裁）。
  行内输入框用 `flex: 1 1 160px` + `min-width`，而不是"占满再被压扁"。
- **多选**（阶段 6d）：Ctrl/Cmd 点选、Shift 连选、行首复选框，另有可见的
  「多选」入口（桌面没有长按这个手势）。选中键**必须用 `uniqueKey` 语义**
  （`trackKey()`），不能用 `track.id` —— 搜索结果里是 `aid`、收藏夹是
  `bv2av(bvid)`、分P 是 `cid`、本地是 DB trackId，跨列表会**串味**。
  ⚠️ **必须能退出**：安卓端把返回按钮整组换成批量动作后，屏幕上没有任何退出入口；
  桌面端补了「清除选择（Esc）」+ Esc 键。
  ⚠️ 全选 / 反选**不能**跟着"选中为 0"一起禁用 —— 反选之后恰好选中 0 首，
  若把全选也禁掉，用户就再也点不回来了（实测踩到）。
- **控件的外观必须与它是否可交互一致**：禁用的滑杆如果还画着主色轨道，
  用户会以为它生效了。凡"看起来能用其实不能用"（以及反过来）都是盲区 ——
  DOM 正常、尺寸正常，**只有人眼看得出**。
- **主页 = 热力图 + 快捷入口 + 最近更新 + 播放历史**（阶段 6d）。
  ⚠️「最近更新」**不是**「近期歌单」：安卓端那条按 `updatedAt` 排序，而
  `playlists.updatedAt` 只在歌单被**修改**时才动（播放写 `play_history`，
  不碰它）。标题与说明都如实写「按歌单最近一次修改排序（不是最近听过）」。
- **热力图是纯 SVG 自绘**（`renderer/heatmap.js`），只复用
  `packages/heatmap` 的**规则**（53 周 × 7 天、固定档位 ≥1/2/3/4、
  主题主色 20/40/60/100%、空单元中性面、有数据/没数据都画网格）——
  那个包是 React Native SVG 组件，渲染进程没有 React。
- **容器与子项的 `data-testid` 不能共享前缀**。卡片叫 `home-playlist-<id>`，
  容器就不能叫 `home-playlist-grid`：`[data-testid^="home-playlist-"]`
  会**先命中容器**，探针点它等于点一个没有监听器的 `div`（什么都不发生），
  而读标题又能读到第一张卡的内容 —— 看起来像"功能坏了"。
- **"先画占位、再用真实数据覆盖"时，占位的调度不能比数据路径更晚**。
  热力图第一版把占位网格放进 `requestAnimationFrame`，而数据来自本地 IPC
  的 `.then` —— **IPC 比一帧还快**，于是真实数据先画上去、一帧后空网格再覆盖它，
  表现是"数据已经到了、界面全灰"。凡这类"两层写入"，都要问一句"谁后写"。
- **只断言"渲染器能画"不等于"数据真的来了"**：热力图那条断言最初喂的是
  **构造数据**，四档颜色全对，而应用自己的 IPC 路径根本不通。现在额外有一条
  "数据走通 IPC **且界面上出现非空档**"的端到端断言。

### 探针怎么不打扰人（硬约束）

用户要求测试**静默启动、绝不占用实体键鼠**（他在打游戏）。探针本来就不用 OS 级
输入（走 `webContents.executeJavaScript` 驱动 `el.click()`），所以要做的只有
"窗口不出现、不抢焦点"：

- 探针窗口 `show: false` + `skipTaskbar: true`；但必须配合
  `backgroundThrottling: false` + `paintWhenInitiallyHidden: true` ——
  隐藏窗口默认被节流、合成器不产帧，那样 `capturePage()` 会截出**纯色图**。
- **探针崩溃不能弹系统模态框**：Electron 对主进程未捕获异常弹原生对话框，
  那会抢焦点。探针模式下改为打到 stderr + 非 0 退出。
- **探针崩溃不能算通过**：`.catch(console.error)` + `.finally(app.exit(0))`
  会让驱动崩溃也返回退出码 0 —— 实测套件报「通过 122 项，失败 0 项」而
  **后面的断言根本没跑**。已加 `probeFailed` 标记接到退出码上。
- 巡检的**像素体检**：数一张截图里不同颜色的个数，≤2 种判为空图。
  DOM 体检**证明不了画出来了**。

### 验证：断言证明不了"好不好看"

- `pnpm verify:desktop:ui` —— 160 条断言（设计系统级：字阶、选中态一致性、
  图标合字、封面形状、`[hidden]` 审计、DOM 嵌套、配色对比度、菜单桥、
  歌单卡片网格、多选、主页与热力图…）。
- `pnpm verify:desktop:tour` —— **截图巡检**：每个视图 / 弹窗 / 空状态都截图
  （浅色 + 深色各 36 张），并写一份"体检表"（关键容器的尺寸、display、
  opacity、**祖先链**）。断言全绿但界面空白的那几次，全是靠体检表定位的。
- `pnpm check:probes` —— 探针脚本静态检查（已接 pre-commit）。
  探针驱动跑在主进程里，**加载失败 = 整个应用起不来**；而
  "在模板字符串内部的注释里写反引号"这个坑踩过**五次**（反引号会当场结束
  模板，且全局数量仍然配平，数奇偶看不出来）。
- ⚠️ **验证盲区（已修）**：根 `oxlint.config.mts` 原有一条「排除所有 `.js`」的规则，
  本意是排除生成的/配置型 JS，但**顺带把桌面端整个渲染进程也排除掉了**
  （`renderer` 下 20 个**手写**文件），于是那批文件**从来没有被 lint 过** ——
  `pnpm lint` 干净对它们是空的。现在只排除真正需要排除的那几个（移动端的
  Expo config plugin / drizzle 生成物、以及 babel/metro/入口这类构建配置），
  全仓库被它挡住的 JS 一共只有 7 个（移动端）+ 3 个（杂项），已逐条写明理由。
  **移动端的有效 lint 集合没有变化**。
  首次开启后渲染进程报出 **36 条**，其中两条是**真问题**：`theme.js` 的
  `describe()` 里 `primary` 被声明了两次（后一个静默覆盖前一个，当前取值恰好
  相同所以看不出来），`settings-panel.js` 有个没人用的赋值。其余为风格清理。
  ⚠️ 渲染进程有两条规则被**就地放开**，理由写在配置里（不是"嫌麻烦"）：
  `no-console`（渲染进程没有别的日志出口）、
  `unicorn/consistent-function-scoping`（它要求把模块级助手移到"外层作用域"，
  而这些模块是 `index.html` 里的**普通 `<script>`** —— 外层就是全局对象，
  提升后 `setStatus` 会出现 **9 个同名全局函数**互相覆盖，是规则自己引入的 bug）。
  另外 pre-commit 钩子原本会在"暂存文件全被忽略"时误判失败，已修
  （"没有可检查的文件"不是失败）。

### 图标字体为什么随源码提交

`renderer/assets/material-symbols-rounded.woff2` 由
`pnpm --filter @bbplayer/desktop build:icon-font` 生成，**不是**构建产物：

- CI / 别人 clone 之后不该需要联网才能构建；
- 上游改了图标集不该让历史提交的产物变样；
- `build/` 是 gitignore 的，放那里等于"每次都要重新下"。

两个实测有效的细节：变量轴**只留 FILL 可变**能把体积从 69 KB 压到 10 KB；
且 Google Fonts 对**不存在的图标名不报错**，只是把图标从子集里悄悄去掉 ——
于是合字不生效、界面渲染出字面的图标名（实测一条 144px 宽的 `play_next`
压在时长列上）。所以构建脚本会**逐个校验名字**。

### 为什么数据库 schema 与移动端同源

建表 SQL 来自 `drizzle-kit` 从 `packages/core/src/db/schema.ts` 生成的
**单文件基线** `drizzle/0000_baseline.sql`（9 张表 + 全部索引/外键）。

上游那套增量迁移链**在空库上跑不通**：`0002_groovy_maximus.sql` 去读
`artists.source` / `artists.remote_id` / `playlists.remote_sync_id`，而这几个列
**没有任何迁移创建过**（全仓搜索确认），跑到 0002 必然
`no such column: "source"`。基线方案保证最终结构与移动端一致，因此备份互通成立。

`apps/desktop/drizzle/` 与 `apps/mobile/drizzle/` 是**两条独立的链**，
只保证最终结构一致，不保证迁移历史一致。

---

## 独立歌词窗口（Phase 4.1）

无边框 + 透明背景 + 置顶的悬浮歌词窗口，数据由主窗口经主进程转发
（渲染进程之间不能直接通信）。用 Ctrl+Alt+L 或右栏工具栏的「独立窗口」开关。

**它也是主窗口歌词渲染问题的可用绕过路径**：主窗口右栏那个已知问题
（setLyrics 状态正确但行元素不渲染）在独立窗口里不存在 —— 后者用的是
完全独立的渲染实现，实测 5 行全部进 DOM、高亮类与 ranslateY 都正确
（见 \pnpm verify:desktop:lyrics-win\，38 项断言）。详见
[\docs/LYRICS.md\](../../docs/LYRICS.md) §6。

---

## 系统媒体集成

`navigator.mediaSession` 在 Electron 里直接可用：Windows 走 **SMTC**、
Linux 走 **MPRIS**，不需要写原生代码。另外两件渲染进程做不到的事由主进程做：

- **任务栏缩略图按钮**（`setThumbarButtons`）：图标是**运行时生成**的
  32×32 PNG（Node 内置 `zlib`，零依赖）。第一版把 base64 硬编码进源码，
  结果四个图标是同一串占位图、而且只有 16×16，所以现在有专门的验证脚本
  （`verify:desktop:icons`）。
- **硬件媒体键兜底**（`globalShortcut`）：**默认关闭**。它与 MediaSession
  同时生效会让一次按键触发两次（播放→暂停→播放，表现为「按了没反应」），
  且 `globalShortcut` 在 Wayland 上通常无效。只在 `--media-keys` 下启用。

---

## 下载

- 落 `userData/downloads`，扩展名恒为 **`.m4a`**。dash 音频是 `.m4s`，
  而 m4s 与 m4a 同为 ISOBMFF 容器，**改扩展名即可播放** —— 因此不引入 ffmpeg。
- `.part` 临时文件 + HTTP `Range` 断点续传；带 `Content-Length` 时校验完整性，
  不完整则失败并**保留 `.part`**，且**不生成成品文件**（否则用户以为下好了）。
- 主地址失败时逐个尝试 `backupUrl`（移动端解析了备用地址但从不使用）。
- 并发默认 2（夹在 1–6，与移动端同区间）。

---

## 备份与恢复（**与移动端格式互通**）

移动端的备份是一个 **ZIP，内含原始 SQLite 快照**，不是 JSON 记录级导出：

```
backup-<ISO 时间戳，冒号与点都换成 ->.bbplayer
  ├── database.db     VACUUM INTO 的原始字节（不压缩 —— JSZip 默认 STORE）
  └── manifest.json   {"version":2,"exportedAt":…,"mmkv":{…},"orpheus":{…}}
```

远端文件名**必须**匹配 `/^backup-.+\.bbplayer$/`，否则移动端列不出来。
WebDAV 复用 `packages/core` 的平台无关客户端（移动端注入 RN fetch、
桌面注入 Node fetch，两端同一份代码，Basic → Digest 回退也由 core 处理）。

### 两个会静默毁数据的互通陷阱

**🔴 `__drizzle_migrations` 两端结构不同**，而 `VACUUM INTO` 会把它复制进快照：

| 生成方                     | 表结构                                             |
| -------------------------- | -------------------------------------------------- |
| 移动端（drizzle migrator） | `(id SERIAL, hash text, created_at numeric)`       |
| 桌面端（手写 runner）      | `(id TEXT, applied_at INTEGER)`，`id` 存迁移文件名 |

两个方向都会炸：移动端备份在桌面恢复 → 桌面 runner 拿到整数 id，永不等于文件名
→ 重放 `0000_baseline.sql`，而它**一个 `IF NOT EXISTS` 都没有** →
`table artists already exists`；桌面端备份在移动端恢复 → drizzle 查
`created_at` → `no such column: created_at`。处理：导出时规范成移动端形状，
导入时规范成桌面形状。详见 [`docs/DESKTOP_PLAN.md`](../../docs/DESKTOP_PLAN.md)
的 Phase 4 一节。

**🔴 五个 JS 数据迁移此前只在移动端跑过**，桌面生成的库里 `sort_key` 等字段
可能没被规范化。恢复时调用它们（幂等），并把 core 端口**临时重指**到正在处理
的那个库 —— 否则它们取到的是已关闭的活跃库连接。

**🔴 `sort_key` 的方向两端一度相反**，会让备份恢复后的歌单**整单倒序**：

|                | 生成                                  | 读取                     |
| -------------- | ------------------------------------- | ------------------------ |
| 移动端         | fractional-indexing，**越靠前键越大** | `ORDER BY sort_key DESC` |
| 桌面端（修前） | `` `a${index 补零}` ``，越小越靠前    | `ORDER BY sort_key ASC`  |

两端各自自洽，单端看不出问题；但备份是整库搬家。已修：顺序约定抽到
`packages/core/src/utils/sortKey.ts` 两端共用，桌面端改成 fractional + `DESC`，
并做了一次性迁移（按**键的形状**逐个歌单判断，而不是只看记账表 —— 恢复移动端
备份会把记账表一起换掉）。详见
[`docs/DESKTOP_PLAN.md`](../../docs/DESKTOP_PLAN.md) 的「备份与移动端互通」一节，
验证见 `pnpm verify:sortkey`。

**恢复后必须重启应用**：Windows 上打开着的文件不能被 rename（实测 `EBUSY`），
恢复前必须关掉数据库连接。桌面端为此加了断路器：关闭后任何访问都抛
「需要重启应用」，而不是让调用方拿到一个「读到旧内存页」的连接。

---

## 为什么音频必须走主进程代理

实测（`node scripts/probe-bilibili-audio.mjs`，3 视频 × 3 地址 = 9 样本）：

| 节点类型         | 样本 |  裸请求 | 带 Referer+UA | Range 206 | 带 ACAO |
| ---------------- | ---: | ------: | ------------: | --------: | ------: |
| **upos（主线）** |    5 | **0/5** |           5/5 |       5/5 | **0/5** |
| other            |    2 |     0/2 |           2/2 |       2/2 |     2/2 |
| PCDN（`mcdn.*`） |    2 |     2/2 |           2/2 |       2/2 |     2/2 |

结论：主线 CDN **强制校验 `Referer`**（裸请求 403，**只带 UA 仍然 403**），
而 `Referer` 属于 Fetch 规范的 forbidden request header，渲染进程设不上去。
所以音频由主进程代发：自定义协议 `bbplayer-audio://`，主进程注入请求头、
透传 Range、流式回传。**不需要 `webSecurity: false`。**

⚠️ 实现约束：`protocol.handle` 必须在 `createWindow()` **之前**注册，
否则会静默失效（`<audio>` 报 `MediaError 4 Format error`）。

### 被实测推翻的三个早期结论

1. ~~「CDN 不发 CORS 头」~~ —— 错。`upos-sz-*` **会回显 Origin**，也允许
   Range 预检。真正的阻塞点是 `Referer`。
2. ~~「必须用桌面 UA」~~ —— 错。`Referer` 充分且必要，UA 对结果无影响。
3. ~~「PCDN 放行所以不需要代理」~~ —— 单样本结论。PCDN 不稳定，不能依赖。

> 关于这个 CDN，**单样本结论已经错过两次**。所有相关脚本默认多轮取样，
> 只看成功率。

---

## 登录（Phase 3）

三条路并存，各有明确适用面：

| 方式            | 适用面                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| **扫码**        | 桌面端首选（手机在旁），不接触密码                                                                          |
| **粘贴 Cookie** | 成本最低、最稳的兜底                                                                                        |
| **密码**        | 受 B 站风控：`-105`（要验证码）/ `-106`（要短信）本实现不处理，只如实提示改用前两种；本地另有 5 次/分钟限流 |

### 关键事实

- **公开收藏夹与 UP 合集无需登录**：`fav/folder/created/list-all` 与
  `fav/resource/list` 匿名均 `code=0`。登录只解锁**私密收藏夹**、会员音轨
  与个人化推荐。
- **会员音轨由登录态决定**：匿名时即使 `fnval=4048` 声明要杜比/Hi-Res，
  响应里也只有 `30216 / 30232 / 30280` 三档。
- **密码登录公钥是动态的**：`/x/passport-login/web/key` 返回 PEM 且
  **每次请求都不同**。明文格式是 `hash + 密码`。因此不硬编码公钥。
- **凭据落盘**：优先 Electron `safeStorage`（Windows DPAPI 实测可用）；
  系统无密钥环时退回未加密并**如实告知**（UI 显示「等同明文」警告），
  不静默降级。
- **cookie 从不到达渲染进程**：二维码在主进程生成为 PNG data URL，
  轮询也在主进程；渲染进程拿不到 `qrcode_key`。已由探针断言。

### `remote_sync_id` 的编码（踩坑记录）

「远端歌单 → 本地歌单」的映射**不能用算术打包**：

- 第一版 `命名空间 + id*1000 + 后缀` 限 `id < 1e9` —— 真实收藏夹
  `media_id` 达 `4026748432`（约 40 亿），直接抛错；
- 第二版 `命名空间*1e9 + id` —— 40 亿会**溢出到另一个命名空间**，
  解包成「合集 3026748432」，**静默错包**。

最终方案：`remote_sync_id = 哈希("fav:<id>")`（值域 `[5e15, 5e15+2^48)`），
原始 id 存进 `description` 的 `[[bb:fav:<id>]]` 标记。这样没有「宽度」这个会
失效的假设，id 再大也不会溢出，且值域与移动端同步来的小整数后端 id
不可能相撞。

---

## 外部歌单导入（Phase 3.3）

粘贴一个**网易云歌单链接或 id**，桌面端抓下歌单（匿名接口即可，不需要登录），
逐首到 B 站搜索、打分、匹配，再把选中的结果落进本地库。

网易云与 B 站**没有共同 id**，所以匹配只能靠模糊打分：

| 维度 | 权重 | 说明                                                       |
| ---- | ---: | ---------------------------------------------------------- |
| 标题 | 0.50 | 归一化后**一方包含另一方**记 1.0，否则退化为软相似度       |
| 歌手 | 0.25 | 取「UP 主名相似度」与「歌手名出现在标题里」的**最大值**    |
| 时长 | 0.25 | 两侧单位不同：网易云是**毫秒**，B 站搜索是 **`"4:21"` 串** |

- **负向词罚分**：B 站搜索「歌名」的前几名常年是伴奏 / 鼓谱 / 吉他指弹 / 铃声。
  强负向系数 `0.45`、弱负向 `0.85`，同时命中则叠乘。
- **不做强过滤**：分数低的落到 `review` 交给用户一键确认，**不静默丢弃** ——
  丢一首本来能导入的歌比多问一次更糟。
- 三家权重里有**两家踩过「恒为 0」的坑**（时长单位不对、分隔符拆分方式不对），
  所以每一项都有独立断言，见 `scripts/verify-external-import.mts`。

**QQ 音乐不做**：它的歌单接口需要 `uin` + zzc 签名，**未登录拿不到完整列表**，
属于「先做登录再谈导入」的量级。

---

## 共享歌单（Phase 3.4）

把歌单分享到 BBPlayer 自己的后端，别人用链接订阅后**双向同步**（owner / editor
能改，subscriber 只读）。

### 它需要**第二套身份**

B 站登录态解锁的是 B 站内容（私密收藏夹、会员音轨）；共享歌单是
`apps/backend` 的能力，有独立的账号与 JWT。两者互不相干 —— B 站 cookie 拿到
共享后端毫无用处。所以 `bbplayer-account.cjs` 与 `bilibili-login.cjs` 并存：

|      | B 站登录                  | BBPlayer 账号                    |
| ---- | ------------------------- | -------------------------------- |
| 凭据 | cookie 字典（可粘贴导入） | 用户名 + 密码换 JWT              |
| 失效 | 有有效期，需重新扫码      | JWT **没有 `exp`**，实测不会过期 |
| 落盘 | `bilibili-cookie.json`    | `bbplayer-account.json`          |

**后端地址可配**（默认 `https://be.bbplayer.roitium.com`，与移动端的默认值
一致）。自建实例是真实需求，也让验证脚本能对着本地后端跑而不去写上游的生产库。

### 顺序与身份的两条约定

- **`sort_key` 越大越靠前**，读取用 `DESC`，键是 fractional-indexing 字符串。
  约定唯一定义在 `packages/core/src/utils/sortKey.ts`，两端共用 ——
  详见「备份与恢复」一节里那个会让歌单**整单倒序**的坑。
- **曲目身份以**服务端给的 `unique_key` 为准（`bilibili::<bvid>`，多 P 时带
  `::<cid>`）。移动端拉取时会用重新生成的键去查本地行，差一点就**静默丢弃**；
  桌面端不重新生成。

### 协议里几个必须记住的点

- **写 `remove`，读回是 `delete`**（`POST /changes` 与 `GET /changes` 用词不同）。
- **`track_count` 是字符串**（Postgres `count(*)` 经 `pg` 回来是 bigint 字符串）。
- **`POST /playlists` 不能带尾斜杠**（Hono strict 路由会 404）。
- **LWW 只对曲目操作生效**；`PATCH` 元数据没有时间戳比较，靠客户端按
  `operation_at` 升序推送来摆顺序。
- **邀请码初始是 `null`**（后端只在 rotate 时生成），UI 会显示「生成邀请码」。
- **重复拉取是协议的固有性质**：LWW 用客户端时间戳、游标用服务端时间，两个
  时钟有偏差时刚推上去的行会被重拉。桌面端**不去掩盖它**（更激进的游标会
  永久漏掉别人的改动），因此断言的是**重放幂等**。

### 验证需要一个**本机**后端

`verify:shared` 与 `verify:desktop:shared` 会注册账号、建歌单、传曲目、改角色、
删歌单。上游那个域名是**别人正在服务的库**，不能拿这些动作去写它。两个脚本
都只认 `BBPLAYER_API_URL`，**隧道不在就直接失败**，绝不静默回退到生产地址。

```bash
# 在 VPS 上（仓库已 clone）：wrangler dev + 本地 Postgres，只监听 127.0.0.1
systemctl status bbplayer-backend   # 或 cd apps/backend && pnpm exec wrangler dev --port 8787 --ip 127.0.0.1
# 在本机：把端口接到本地
ssh -i <key> -N -L 8787:127.0.0.1:8787 root@<vps>
# 然后
pnpm verify:shared
pnpm verify:desktop:shared
```

---

## 已知限制 / 下一步

- ~~`window.bbProbe` 无条件暴露~~ —— 已修：只在探针模式下通过 `additionalArguments` 暴露，并有专门的 `--verify-gating` 模式做端到端断言（它故意不属于探针模式，否则永远测不出问题）。
- 渲染进程**没有实现 `AudioPort`**：播放仍直接用 `<audio>` + 自定义协议。
  `packages/core/src/ports/index.ts` 里的 `AudioPort` 接口未接入 —— 这是
  **有意的取舍**：桌面端的播放引擎就是 `<audio>`，抽一层端口目前只增加间接性。
  若将来要与移动端共享播放引擎，这里是接入点。
- **歌词面板的已知缺陷（未定位）**：主界面里 `setLyrics(48)` 状态正确、
  `data-active` 也写进 DOM，但**行元素不渲染**（`li` 为 0、`meta` 显示
  `— / 0`）。同一面板在独立的 `lyrics-lab.html` 里 30/30 通过，所以问题在
  「主界面集成」这一层。详见 [`docs/LYRICS.md`](../../docs/LYRICS.md) §6。
  验证脚本把它记为**警告**而不是通过 —— 不用「状态正确」掩盖「DOM 没渲染」。
  独立歌词窗口走的是另一份渲染实现，**没有这个问题**，可作为绕过路径。
- Phase 5.3（代码签名）未做：Windows 的 NSIS 包未签名，SmartScreen 会提示；
  Linux 包也未签名。
- 外部歌单导入只支持**网易云**；QQ 音乐未做（接口需登录态签名）。
- 共享歌单的**多人同时编辑体验**没有人评过（需要两台真机同时操作）；只断言了
  协议层的 LWW 与重放幂等。
- 外部歌单导入的**匹配语义正确性**（自动匹配上的 B 站视频是否真的是那首歌）
  需要人耳/人眼确认，探针只能断言「分数与负向词符合预期」。200 首量级的
  全量匹配 UI 表现（进度 / 取消 / 滚动）也只做了逻辑断言，未做端到端点击验证。
- 歌词窗口的「锁定」只做到不可拖动；真正的鼠标穿透需要
  `setIgnoreMouseEvents`，属于另一个交互决策。
