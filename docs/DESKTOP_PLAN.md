# BBPlayer Desktop 方案（Electron / Windows + Linux）

> 状态：待评审 · 范围：Windows / Linux 桌面端 · 目标运行时：Electron（主进程 = Node，渲染进程 = Web）
> 本文档基于对当前仓库的只读审计，所有结论均附 `文件:行` 证据。

---

## 0. 现状与口径

| 指标                     | 数值                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| 全仓 tracked 文件 / 提交 | 1,302 / 1,151                                                      |
| `.git` 体积              | 32.3 MB（含 1.3 MB `pnpm-lock.yaml`）                              |
| `apps/mobile/src`        | **327 文件 / 55,044 行**                                           |
| `packages/*`             | 308 文件 / 2,922 行（仅少数可复用）                                |
| 原生代码                 | Kotlin 100 文件（其中 orpheus 83）、Swift 24 文件                  |
| 当前目标平台             | `platforms: ['android', 'ios']`（`apps/mobile/app.config.ts:108`） |
| 平台分支文件             | `.web.*` / `.native.*` = **0**                                     |

**口径说明**：桌面端不是「移植 mobile」，而是「复用逻辑、重写呈现」。判断某块代码能否复用的唯一标准是：_它是否 import 了 React Native / Expo / `@bbplayer/{native,orpheus}`_。

---

## 1. 代码复用审计

### 1.1 总账

| 分类               |       行数 | 占比 | 说明                            |
| ------------------ | ---------: | ---: | ------------------------------- |
| ✅ 几乎原样复用    |  **5,682** |  10% | 零 RN 依赖                      |
| 🟡 换 import 即可  |  **4,808** |   9% | 只依赖 4 个可替换的接缝         |
| 🟡 抽核心 + 换实现 |  **2,926** |   5% | 逻辑要抽，平台部分重写          |
| 🟡 按新壳重写      |  **3,465** |   6% | 数据层/hook 层，逻辑可搬        |
| 🔴 硬重写          |    **583** |   1% | 强绑 RN/Expo 配置               |
| 🔴 完全重做        | **37,580** |  68% | UI 33,209 + 播放引擎 + 原生模块 |

### 1.2 ✅ 几乎原样复用（`packages/core/src/` 直接搬）

| 模块                                                                                          |   行数 | 证据                                                     |
| --------------------------------------------------------------------------------------------- | -----: | -------------------------------------------------------- |
| `lib/db/schema.ts`                                                                            |    319 | 纯 `drizzle-orm`，Drizzle 双端可用                       |
| `lib/errors/{index,service,facade,player}.ts` + `errors/thirdparty/*`                         |    340 | 纯 `neverthrow`                                          |
| `lib/api/bilibili/{garb,utils}.ts`                                                            |     79 | 零依赖                                                   |
| `lib/api/bilibili/wbi.ts`                                                                     |    113 | **B 站 WBI 签名**，只依赖 `@/utils/log` + mmkv（可注入） |
| `lib/api/netease/{api,crypto,utils}.ts`                                                       |    306 | **eapi 加密**，零 RN 依赖                                |
| `lib/backup/{types,webdav-client}.ts`                                                         |    291 | 已跑在 `testEnvironment: 'node'`                         |
| `lib/services/{genKey,externalPlaylistService,syncLocalToBilibiliService}.ts`                 |    488 | 零 RN 依赖                                               |
| `lib/facades/{bilibili,playlist,sharedPlaylist,syncBilibiliPlaylist,syncExternalPlaylist}.ts` |  2,924 | 只碰 4 个接缝                                            |
| `lib/theme/{schema,types,transformer}.ts`                                                     |    394 | 纯函数                                                   |
| `lib/types/**`（大部分）                                                                      | ~1,600 | 纯类型                                                   |
| `packages/splash`                                                                             |    807 | **RN/Expo 引用数 = 0**                                   |
| `packages/logs`                                                                               |    981 | 依赖注入式 transport                                     |
| `packages/heatmap`                                                                            |    656 | 纯 TS + `react-native-svg`（渲染层需换）                 |

### 1.3 🟡 换 import 即可（4 个接缝）

| 接缝    | 现状                                         |    出现次数 | 桌面端替换                                   |
| ------- | -------------------------------------------- | ----------: | -------------------------------------------- |
| DB 实例 | `@/lib/db/db`（`expo-sqlite`）               |          12 | `better-sqlite3` / `node:sqlite`             |
| 日志    | `@/utils/log`（`expo-file-system` + Sentry） | **51 文件** | `@bbplayer/logs`（已是纯 JS）                |
| KV 存储 | `@/utils/mmkv`（`react-native-mmkv`）        | **22 文件** | 新建 `@bbplayer/storage`（桌面 = 落盘 JSON） |
| HTTP    | `react-native-nitro-fetch`                   |           8 | Node 原生 `fetch`                            |

> **关键发现**：这 4 个接缝都是**通过项目内薄封装**引入的（`@/utils/log`、`@/utils/mmkv`、`@/lib/db/db`），没有任何业务文件直接 import RN 库。**替换 = 改封装 + 换 import 路径，不碰业务逻辑。**

### 1.4 🟡 抽核心 + 换实现

| 模块                                                           |  行数 | 复用部分                         | 重写部分                                   |
| -------------------------------------------------------------- | ----: | -------------------------------- | ------------------------------------------ |
| `lib/services/{playlistService,trackService,artistService}.ts` | 2,741 | 业务逻辑、查询、`ResultAsync` 流 | `expo-sqlite` 类型、`@sentry/react-native` |
| `lib/backup/{export,import,webdav}.ts`                         |   191 | 数据契约                         | `expo-file-system`、`@bbplayer/native`     |
| `lib/services/lyricService.ts`                                 |   625 | 智能匹配、缓存、偏移             | `Orpheus` 推送、`FileSystem`               |
| `lib/workers/PlaylistSyncWorker.ts`                            |   451 | 同步调度逻辑                     | 去掉 `@/hooks/stores/useAppStore` 依赖     |

### 1.5 🟡 按新壳重写（逻辑可搬，形态必须换）

| 模块                                                    |   行数 | 说明                                                                           |
| ------------------------------------------------------- | -----: | ------------------------------------------------------------------------------ |
| `lib/player/{seek,progressListener,playbackSession}.ts` |    141 | 全部围绕 `Orpheus.*` — **定义 `AudioPort` 即可原样复用**（见 §2.2）            |
| `hooks/player/*`                                        | ~1,900 | `useSmoothProgress` 用 `react-native-reanimated`；改用 `requestAnimationFrame` |
| `hooks/stores/*`（Zustand）                             |    448 | **Zustand 是框架无关的**，vanilla store 可直接用                               |
| `hooks/{queries,mutations}`（React Query）              | ~2,135 | React Query 桌面可用，只需换 `queryClient` 配置                                |
| `lib/config/{queryClient,sentry}.ts`                    |    174 | 换成桌面等价物                                                                 |

### 1.6 🔴 必须重写

| 模块                                                                                                  |                行数 | 原因                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ------------------: | ------------------------------------------------------------------------------------------------------------------------------------ |
| `app/` + `components/` + `features/`                                                                  |          **33,209** | React Native 组件树；`react-native-paper`(134)、`react-native-reanimated`(26)、`expo-router`(67)、`react-native-gesture-handler`(23) |
| `Orpheus` 播放引擎                                                                                    | 83 Kotlin / 9 Swift | 完全原生，零 TS                                                                                                                      |
| `packages/{native,expo-wavy-slider}`                                                                  |                 912 | `platforms: ["android"]`；`PlayerSlider.tsx:3` 顶层导入 wavy-slider                                                                  |
| `lib/theme/{material3Colors,runtime,SkinManager,downloadManager}.ts` + `@bbplayer/image-theme-colors` |                 611 | Android 原生取色、换肤下载                                                                                                           |
| `lib/{performance,services/{analyticsService,updateService,updateTelemetry}}.ts`                      |                 537 | `react-native-release-profiler`、Firebase、`expo-updates`                                                                            |
| `lib/db/migrations/*.ts`                                                                              |                 300 | **SQL 逻辑可复用**，但执行器要换（移动端是 `useFastMigrations` 内联执行）                                                            |

---

## 2. 桌面端技术架构

### 2.1 进程与职责

```
electron/main       纯 Node 进程
  ├─ 消费 packages/core（9.5k 行业务逻辑，零适配）
  ├─ better-sqlite3（Drizzle driver 换掉 expo-sqlite）
  ├─ 日志 → 文件
  ├─ 音频/CDN 请求代理（见 §2.3，这是桌面端最重要的技术决策）
  └─ IPC server

electron/renderer   Web 进程
  ├─ 新 UI（React + 自选组件库）
  ├─ <audio> / WebAudio 播放
  ├─ 桌面歌词窗口（独立 BrowserWindow）
  └─ MediaSession（系统媒体键 / 任务栏缩略图控制）
```

**为什么业务逻辑放主进程**：主进程就是 Node，`fetch` / `fs` / SQLite 都是原生能力 —— 你最初担心的「9.5k 行靠 Node 跑」在这里**不需要任何适配层**。

### 2.2 `AudioPort`：复用播放层逻辑的钥匙

移动端实际调用 `Orpheus` 共 **65 个方法**，但真正被播放器业务逻辑使用、需要跨端一致的核心只有 **25 个**：

```
play / pause / skipToNext / skipToPrevious / seekTo / skipTo / setPlaybackSpeed
setRepeatMode / setShuffleMode / getRepeatMode / getShuffleMode
getCurrentTrack / getQueue / getCurrentIndex / getPosition / getDuration / getBuffered
getIsPlaying / addToEnd / playNext / removeTrack / clear / reverseRemainingQueue
setSleepTimer / getSleepTimerEndTime / cancelSleepTimer
```

**做法**：新建 `packages/core/src/ports/audio.ts` 定义这个接口，把现有 `lib/player/*.ts` 从 `import { Orpheus }` 改为注入 `AudioPort`。这样：

| 端      | 实现                                                 |
| ------- | ---------------------------------------------------- |
| mobile  | `Orpheus`（现有原生模块，包一层）                    |
| desktop | 主进程 `HTMLAudioElement` 或渲染进程 `<audio>` + IPC |

剩下 **40 个方法是移动端专属**（桌面歌词悬浮窗、状态栏歌词、车机、下载、APK 更新、目录选择器、导出、headless），**不进 `AudioPort`**，由各端自行处理。这也顺带解决了 iOS 上 `setLyrics` 必抛的问题。

### 2.3 ⚠️ 关键发现：B 站音频有防盗链 + 主线 CDN 无 CORS（已实测确认）

**代码证据**：

- `packages/orpheus/android/.../NetworkModule.kt:42-45` — OkHttp 拦截器注入 `User-Agent` + `Referer: https://www.bilibili.com/`
- `packages/orpheus/android/.../DownloadUtil.kt:142,154` — 下载同样注入 cookie + Referer

**实测证据**（`scripts/probe-bilibili-audio.mjs`，3 个视频 × 3 个地址 = 9 个样本）：

| 节点类型         | 样本 | 裸请求 200 | 带头 200 | Range 206 | 带 ACAO |
| ---------------- | ---: | ---------: | -------: | --------: | ------: |
| **upos**（主线） |    5 |    **0/5** |      5/5 |       5/5 | **0/5** |
| other            |    2 |        0/2 |      2/2 |       2/2 |     2/2 |
| PCDN（`mcdn.*`） |    2 |        2/2 |      2/2 |       2/2 |     2/2 |

结论：

1. **防盗链是真的**：7/9 地址裸请求返回 **403**，带上 `Referer` + 桌面 UA 后 200。
2. **主线 CDN 不返回 `Access-Control-Allow-Origin`**（upos 5/5 都无）→ 渲染进程直接
   `<audio src="https://…bilivideo.com/…">` 会被 **CORS 拦掉**。
3. **Range 全支持 206** → seek 可以正常工作（前提是代理把 `Range` 透传）。
4. **PCDN 节点（`mcdn.bilivideo.cn`）会放行裸请求**，但节点分配不可控，**不能作为依赖**。
   （第一版探测只测到一个 PCDN 地址，因此得出「不需要代理」的错误结论 —— 样本偏差。）

**影响**：必须由主进程代发音频请求（防盗链的需要）。

**两种方案的实测对比**：

| 方案                                | 做法                                                       | 实测结论                                                                             |
| ----------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **A. 自定义协议代理**（已采用）     | 主进程注册 `bbplayer-audio://`，带 header 发请求、流式回传 | ✅ **可用**：`verify-desktop.mjs` 18/18 通过，含播放推进、seek、Range 精确 1024 字节 |
| B. `session.webRequest` 注入 header | 注入 `Referer`，渲染进程直接播 CDN 地址                    | ✅ **也可用**（见下方修正）；定位为兜底 / 快速验证路径                               |

**选 A 的理由不是「B 不行」，而是 A 更可控**：

1. 请求头完全由主进程构造，不受 Fetch 规范 forbidden header 限制，也不受 `webRequest`
   的「同名监听器只有最后一个生效」约束；
2. 入口收敛：签名 URL 获取、头注入、缓存 / 重试 / 限流都在一处；
3. 渲染进程拿不到真实 CDN 地址，安全面更小（应当用 `request.initiatorOrigin` 做白名单）。

#### ⚠️ 三处早期结论被实测推翻（记录以免重犯）

1. **「CDN 不返回 CORS 头」——错误。**
   实测：`upos-sz-*` 系主机在请求带 `Origin` 时**回显该 Origin**，且 `OPTIONS` 预检返回 200
   并允许 `Range`；`cn-sccd-*` / `*.edge.mountaintoys.cn` / `mcdn` 直接给 `ACAO: *`。
   → **CORS 本身是通的**。方案 B 需要主进程介入的真正原因是
   **`Referer` 属于 Fetch 规范的 forbidden request header，渲染进程 JS 设不上去**
   （实测 `fetch(url, { headers: { Referer } })` 仍 403，该头被静默丢弃）。
   因此**不需要 `webSecurity: false`**（两方案实测都不需要；官方安全指南也禁止生产使用）。

2. **「必须带桌面 UA」——不成立。**
   20 个 host 的矩阵实测：15/20 强制校验 `Referer`（无 Referer 即 403，**仅带 UA 仍然 403**），
   5/20（`*.mcdn.bilivideo.cn:8082`）完全不校验。**`Referer` 充分且必要，UA 对结果无影响**
   （保留它只是为贴近真实浏览器指纹，无害）。

3. **`protocol.handle` 必须在创建窗口之前注册**（实测，文档未载）。
   对照实验：窗口 `loadURL` 完成之后再 `protocol.handle`，`<audio>` 报
   `MEDIA_ELEMENT_ERROR: Format error`、`fetch` 报 `TypeError: Failed to fetch`；
   先注册再建窗口则正常。本仓库实现满足该顺序（`main.cjs` 第 94 行注册、第 141 行建窗口）。

4. **CDN 原生支持 Range，代理只需透传，不必自己算 206。**
   实测 `seekable.end(0) === duration`（全长可拖），seek 到 106.2s 成功。

复验方式：

- `node scripts/probe-bilibili-audio.mjs` —— CDN 防盗链与 CORS 的逐节点统计
- `node scripts/compare-audio-strategies.mjs` —— 两方案多轮对比（`COMPARE_ROUNDS` 可调）
- `node scripts/verify-desktop.mjs` —— 生产路径（方案 A）的 18 项断言
- **别用 `HEAD` 探活**：`mcdn` 节点对 HEAD 返回 404（实测）

### 2.4 打包策略（避开 pnpm + monorepo 的坑）

```
阶段 1  build：esbuild / tsup
    packages/core + electron/main + ipc handlers → 单个 main.cjs
    renderer → Vite 产出静态资源

阶段 2  dist：electron-builder
    files:      只含 dist/ + 裁剪过的生产依赖
    asarUnpack: 只放 better-sqlite3 等原生模块
    exclude:    packages/*/{android,ios}、apps/mobile、.agents
```

**原则**：bundle 用你熟悉的工具链（esbuild + pnpm），分发用 electron-builder 只处理产物，两边都不理解对方。

**具体坑与对策**：

1. pnpm symlink → build 阶段 bundle 掉，dist 阶段只发产物
2. 原生模块 ABI → `better-sqlite3` 必须 `electron-rebuild`
   （本仓库已改用 **`node:sqlite`**，Node 22.5+ 内置，**绕开了这个问题**）
3. workspace 解析 → electron-builder 不接触 `workspace:*`（已被 bundle）
4. `packages/*/android/**` 被误打包 → `files` 白名单强制约束

#### 打包的实测约束（重要，决定 P5 怎么做）

**Windows 上不能产出 Linux 安装包格式**（实测 electron-builder 26.15.3）：

| 目标                  | 结果 | 实测错误 / 产物                                                 |
| --------------------- | ---- | --------------------------------------------------------------- |
| `--linux deb` / `rpm` | ❌   | `spawn fpm ENOENT`（fpm 未随 Windows 版捆绑）                   |
| `--linux AppImage`    | ❌   | `...\appimage-...\darwin\mksquashfs ENOENT`                     |
| `--linux dir`         | ✅   | `out/linux-unpacked/…`，文件头 `7F 45 4C 46` = **真 Linux ELF** |
| `--linux tar.gz`      | ✅   | 可直接分发、目标机解压即用                                      |

→ **要 `.deb` / AppImage 必须用 Docker（`electronuserland/builder`）或 Linux runner。**
本机**没有 Docker、也没装 WSL**，因此 Linux 侧的正式打包在 **VPS** 上做。

#### Electron 二进制安装（实测）

**Electron ≥ 42 已删除 `postinstall`**，二进制改为**首次 `require('electron')` 时懒下载**。
所以 `pnpm install` 之后 `dist/` 为空是**预期行为**，不是安装失败
（`pnpm-workspace.yaml` 的 `allowBuilds` 未列 electron 也不是原因）。

直连 GitHub 实测仅 **0.05 MB/s**（142 MB 要约 50 分钟，看起来像卡死）；
用镜像 **24.5s** 完成（约 34×）：

```bash
ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ node install.js
```

→ 建议写进 `.npmrc`：`electron_mirror=https://registry.npmmirror.com/-/binary/electron/`

---

## 3. 交互逻辑重新设计（手机 → 桌面）

### 3.1 范式差异总表

| 维度      | 移动端现状                                                       | 桌面端设计                                                            |
| --------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| 导航      | 3 个底部 Tab（`(tabs)/_layout.tsx:78,91,105` 主页/音乐库/设置）  | 左侧边栏，**列表常驻可见**                                            |
| 页面      | 全屏 stack，一次一页                                             | 三栏并存，页面不再独占                                                |
| 播放器    | 全屏 `app/player.tsx`，从 NowPlayingBar 推入                     | 中栏/右栏常驻，**不再"进入"播放器**                                   |
| 元信息    | NowPlayingBar（已支持 bottom/float 两种高度）                    | 底部常驻控制条 + 右侧歌词/队列面板                                    |
| 手势      | 上下滑收/展队列（react-native-true-sheet）、左右滑切歌、长按多选 | 双击播放、右键菜单、拖拽排序、框选、Shift/Ctrl 多选、hover 操作       |
| 快捷键    | 无                                                               | 全局媒体键 + `Space`/`←→`/`Ctrl+F` 等（见 3.4）                       |
| 分享      | 系统分享面板、二维码、存相册                                     | 复制链接 + 生成分享图导出到文件                                       |
| 歌词      | 全屏歌词页、悬浮窗（`SYSTEM_ALERT_WINDOW`）、状态栏歌词          | 常驻右侧面板 + **独立可拖动歌词窗口**；**状态栏歌词整块砍掉**         |
| 通知/后台 | 前台服务、Media3 通知                                            | `MediaSession`（Win 任务栏缩略图 / Linux MPRIS）                      |
| 更新      | `@bbplayer/native` 下载 APK 并调系统安装器                       | `electron-updater`                                                    |
| 登录      | 扫码 / 短信 / Cookie（`settings/bilibili-account/*`，9 个页面）  | 扫码（浏览器完成授权后回跳）+ Cookie 粘贴；**短信验证码在小窗里保留** |

### 3.2 新的信息架构：三栏 + 底部播放条

```
┌──────────┬────────────────────────────────┬───────────────┐
│ 侧边栏    │  主内容区                        │  Now Playing  │
│ (240px)  │                                 │  面板 (320px) │
│          │                                 │               │
│ 发现      │  当前选中项的列表/详情             │  封面 + 歌词   │
│ 音乐库    │  （歌曲表 / 歌单详情 / 搜索结果）    │  或 播放队列   │
│ 歌单      │                                 │  （可切换）    │
│ 历史      │                                 │               │
│ 下载      │                                 │               │
│ 设置      │                                 │               │
├──────────┴────────────────────────────────┴───────────────┤
│ ◀◀  ▶  ▶▶ │ ▬▬▬▬▬▬●▬▬▬▬ │ 曲名 - 歌手 │ 🔀 🔁 🔊 ⛶ │
└───────────────────────────────────────────────────────────┘
```

**理由**：

- 底部 Tab 在桌面上是浪费 —— 3 个入口却有 40 个页面，必须换成侧边栏展示**全部一级入口**
- **队列面板常驻 + 可切歌词**，替代移动端"上下滑收展 sheet"。桌面用户调队列的频率远高于手机，modal 式队列（`PlayerQueueModal.tsx`）会成为高频摩擦
- 需要保留「沉浸模式」（隐藏左右栏，只留歌词）以承接移动端 `player.tsx:5` 的 Skia 流体背景 + 歌词体验

### 3.3 交互改造逐项

| #   | 移动端机制          | 现状证据                                                            | 桌面端改造                                                                    |
| --- | ------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | 底部 Tab 导航       | `(tabs)/_layout.tsx:68-119`                                         | → 侧边栏，含「全部歌单/收藏夹」树                                             |
| 2   | 全屏播放器页        | `app/player.tsx`                                                    | → 右侧常驻面板；保留沉浸模式切换                                              |
| 3   | 上滑 sheet 队列     | `components/modals/PlayerQueueModal.tsx`                            | → 右栏 tab（队列/歌词）                                                       |
| 4   | 长按菜单            | `features/*/hooks/use*Menu.ts`（10+ 处 `ios:`/`android:` 图标映射） | → 右键上下文菜单 + hover 才出现的行内操作按钮                                 |
| 5   | 长按多选            | `LocalTrackList.tsx` 等                                             | → `Ctrl` 点选 / `Shift` 范围选 / `Ctrl+A` 全选 / 框选                         |
| 6   | 下滑关闭 modal      | 29 个 `components/modals/*`                                         | → 窗口内对话框 + `Esc`；高频操作（改名、加歌单）改**行内编辑**                |
| 7   | 分享 sheet          | `SongShareModal.tsx`                                                | → 复制链接 / 导出分享图到文件                                                 |
| 8   | 二维码登录          | `settings/bilibili-account/qrcode-login.tsx`                        | → 应用内扫码（保留）+ 浏览器授权回跳（新增）                                  |
| 9   | 悬浮窗歌词          | `Orpheus.showDesktopLyrics` + `SYSTEM_ALERT_WINDOW`                 | → 无边框透明 `BrowserWindow`（always-on-top），**接口形态一致，实现完全不同** |
| 10  | 状态栏歌词          | `lyrics.tsx:261,279`（SuperLyric / Lyricon / 魅族）                 | → **整块删除**，改用 `MediaSession`                                           |
| 11  | 皮肤/开屏动画       | `lib/theme/SkinManager.ts`、`AnimatedBootSplash.tsx`                | → 主题色保留；**视频开屏 + 动态封面砍掉**                                     |
| 12  | 音频导出到 `Music/` | `Orpheus.exportDownloads` + SAF 目录选择器                          | → 主进程 `fs.copyFile`，**比移动端简单得多**                                  |
| 13  | APK 自更新          | `UpdateAppModal.tsx` + `@bbplayer/native`                           | → `electron-updater`                                                          |
| 14  | 无键盘操作          | —                                                                   | → 全量快捷键（见 3.4）                                                        |

### 3.4 快捷键设计

| 分类 | 按键                  | 行为                                             |
| ---- | --------------------- | ------------------------------------------------ |
| 播放 | `Space`               | 播放/暂停                                        |
|      | `←` / `→`             | −5s / +5s                                        |
|      | `Shift+←` / `Shift+→` | 上一首 / 下一首                                  |
|      | `Ctrl+←` / `Ctrl+→`   | 音量 −5% / +5%                                   |
|      | `↑` / `↓`             | 列表内上下移动选择                               |
|      | `Enter`               | 播放选中项                                       |
|      | `Ctrl+M`              | 静音                                             |
| 模式 | `Ctrl+R`              | 随机开关                                         |
|      | `Ctrl+L`              | 循环模式切换                                     |
| 视图 | `Ctrl+1..5`           | 切换一级入口                                     |
|      | `Ctrl+Q`              | 队列/歌词面板切换                                |
|      | `Ctrl+Shift+F`        | 沉浸模式                                         |
| 功能 | `Ctrl+F`              | 聚焦搜索（**App 级，需处理与列表内搜索的冲突**） |
|      | `Ctrl+,`              | 设置                                             |
|      | `Ctrl+D`              | 下载选中项                                       |
|      | `Delete`              | 从歌单移除                                       |
| 系统 | 媒体键                | `MediaSession` 处理                              |

**架构要求**：在渲染层建一个**中心化快捷键分发器（registry）**，支持「全局 / 上下文相关（焦点在输入框时失效）/ 覆盖」三级优先级。否则 30+ 快捷键必然互相打架。

### 3.5 必须保留的逻辑（换交互但不换行为）

这些是移动端已经写好、**桌面端必须原样继承**的业务语义 —— 交互变了，但决策逻辑不能变：

- 搜索的**多源回退链**与 BV/AV/短链解析（`lib/api/bilibili/api.ts`）
- 音频流的**降级顺序**：杜比 → Hi-Res → 指定音质 → durl 回退（`api.ts:373-420`）
- 外部歌单**匹配算法**与手动匹配（`lib/facades/syncExternalPlaylist.ts`、`ManualMatchExternalSync.tsx` 背后的逻辑）
- 歌单同步的**冲突处理**（`syncBilibiliPlaylist.ts` 1,040 行）
- 歌词**智能匹配 + 偏移 + SPL 逐字**（`lyricService.ts` + `packages/splash`）
- 播放**断点续播策略**（`ResumeStrategy`：NONE / PODCAST）
- 备份格式与 WebDAV 目录结构（**桌面端必须与移动端互通**）

---

## 4. 分阶段计划

### 提交纪律（约定）

**每个 Phase 验证通过后，立即向本地仓库提交一次**，便于回滚与逐阶段评审。

- 提交信息用仓库既有的 scoped commit 风格（`root:` / `mobile:` 等）。
- 提交前必须跑通：`pnpm type-check`、`pnpm check:core`、`pnpm lint`（允许既有错误存在，
  但不得新增）。
- 提交信息要写明**验证方式**与**已知限制**（例如「未在真机运行」），不要只写「完成 X」。
- 遗留的既有失败（如 `jest.webdav`）应标注为「与本次无关」并附上复现依据。

### Phase 0 — 架构基座（不动 mobile 一行行为）✅ 已完成

| 步骤 | 产出                                                                                                                                                  | 状态                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 0.0  | 修复既有类型缺陷：`apps/mobile` 借道编译 `apps/backend` 源码时 `Env` 未解析                                                                           | ✅ `apps/backend/src/env.ts` 显式声明绑定类型，不再依赖环境全局                                                |
| 0.1  | `git mv` 迁移 34 个纯净文件（含 1 个测试）→ `packages/core/`，共 3,393 行                                                                             | ✅ 历史保留（`git log --follow` 可追溯）                                                                       |
| 0.2  | `packages/core/tsconfig.json` 设 `types: []` + `lib: ["ES2023"]`，加入根 references                                                                   | ✅ **已验证**：core 内写 `import 'react-native'` 会编译失败                                                    |
| 0.3  | 定义端口：`LoggerPort` / `StoragePort` / `SecureStoragePort` / `DbPort`（含 `SqliteSyncPort`）/ `HttpPort` / `AudioPort` + `CorePorts` + 运行时注册表 | ✅ `packages/core/src/ports/index.ts`                                                                          |
| 0.4  | 新建 `packages/design-tokens`（间距/圆角/字号/动效/语义色板）                                                                                         | ✅ 171 行                                                                                                      |
| 0.5  | **mobile 提供四个 port 的 RN 实现并在启动时注册**；`apps/mobile` 的 import 路径全部改写                                                               | ✅ `apps/mobile/src/ports/index.ts`（logger / storage / secureStorage / db / http），`app/_layout.tsx:57` 注册 |
| 0.6  | `scripts/check-core-purity.mjs` + `pnpm check:core` + CI 门禁（含补上 `type-check`）                                                                  | ✅ 双向验证通过                                                                                                |
| 0.7  | 数据迁移改为端口注入并搬入 core（6 个文件），验证注入设计可用                                                                                         | ✅ `packages/core/src/db/migrations/`                                                                          |

**验收结果**

| 检查                                          | 结果                                                                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm type-check`（根）                       | ✅ exit 0                                                                                                                                                                     |
| `pnpm check:core`                             | ✅ 43 个文件无违规                                                                                                                                                            |
| 边界强制（core 内写 `import 'react-native'`） | ✅ 编译即失败（每轮均复验）                                                                                                                                                   |
| `pnpm lint`                                   | ⚠️ 1 个**既有**错误（`apps/mobile/src/app/settings/account.tsx:73`），与本次无关                                                                                              |
| `pnpm install` / `pnpm check:deps`            | ✅                                                                                                                                                                            |
| `jest.webdav`                                 | ⚠️ **既有失败**（TypeScript 6.0 + ts-jest 的 `moduleResolution=node10` 弃用报错）。已用 `git show HEAD:apps/mobile/jest.webdav.config.cjs` 原配置对照复现，确认与本次迁移无关 |

**core 最终规模**：43 个文件 / 3,764 行（迁移 34 个文件用 `git mv` 保留历史）。

**端口注入已验证**：`packages/core/src/db/migrations/` 里的迁移代码不再 import
`expo-sqlite` / `@/utils/log` / `@/utils/mmkv`，而是通过 `getCorePorts()` 取用；
`apps/mobile` 在 `_layout.tsx` 注册实现。这证明了「9.5k 行逻辑两端共用」的机制可行。

**未纳入 Phase 0 的部分（有意推迟）**

- 其余仍留在 `apps/mobile/src/lib/` 的纯逻辑（`facades/*` 2,924 行、`services/{playlist,track,artist}Service`、
  `theme/adapter.ts`、`workers/PlaylistSyncWorker.ts`、`api/*/client.ts`、`wbi.ts`）：它们的接缝是
  DB 实例 / HTTP / 日志的**直接 import**，要搬到 core 需先把调用点改为端口参数注入，
  属于 Phase 1～2 的连续工作，届时两端同时消费端口才是验证时机。
- `design-tokens` 尚未被 mobile 消费：把散落的 `borderRadius: 24/20/12/8/4` 字面量改为引用 token
  会产生视觉回归风险，安排在桌面端 UI 动工前（Phase 2）一并处理。

### Phase 1 — Electron 骨架 + **音频可行性验证** ✅ go/no-go 已通过

| 步骤 | 产出                                                                                                  | 状态        |
| ---- | ----------------------------------------------------------------------------------------------------- | ----------- |
| 1.0  | 环境：确认 Electron 42.11.3 可用；二进制缺失（pnpm 跳过 postinstall）需手动下载，已加入 `allowBuilds` | ✅          |
| 1.1  | `apps/desktop/`：主进程 + preload + 渲染进程骨架（暂用 CJS，未引入打包步骤）                          | ✅          |
| 1.2  | 主进程跑通路由层：`packages/core` **已在纯 Node 上验证可用**（13/13）；接 DB 留待 Phase 2             | 🟡 部分     |
| 1.3  | **⚠️ 验证 §2.3**：自定义协议代理能否播放 B 站音频（含 Range、拖动 seek）                              | ✅ **通过** |
| 1.4  | 最小播放器：能播、能 seek、能显示进度（单曲；下一首留待 Phase 2）                                     | 🟡 部分     |

**1.3 的验证结论（决定性）**：能播。`bbplayer-audio://` 自定义协议代理 + 渲染进程
`<audio>` 组合工作正常，且**不需要 `webSecurity: false`**。

自动化验证：`node scripts/verify-desktop.mjs` → **18/18 通过**

| 断言                       | 实测值                                                         |
| -------------------------- | -------------------------------------------------------------- |
| 元数据经自定义协议加载     | `readyState=3`，时长 212.31s                                   |
| 真正开始播放               | 时间推进 0.02s → 2.52s                                         |
| 拖动 seek                  | 3.27s → 30.03s                                                 |
| 上游 CDN 状态码            | **206**（证明 Referer 注入生效；裸请求会是 403）               |
| 代理透传 Range（严格测试） | `Content-Range: bytes 1000000-1001023/5408198`，恰好 1024 字节 |
| 解码缓冲                   | `[[0, 130.54]]`，零媒体错误                                    |

验证方式是**点击级驱动**而非人工观察：主进程用 `webContents.executeJavaScript`
调用渲染进程暴露的 `window.bbTest`（load/play/seek/state），再用 `capturePage`
截图供多模态核对。

**验证过程中修正的两个自身错误**（记录以免重犯）：

1. 首版探测只测到 1 个 PCDN 节点，得出「不需要代理」的**错误结论**。扩到 9 个样本
   （3 视频 × 3 地址）后才发现主线 CDN 全部 403。→ 已在 `resolveAudio` 中
   优先选主线地址，避免用宽松节点自欺。
2. 首轮「上游未返回 206」的失败，根因是命中了 PCDN 节点；换主线后 206 正常。

### Phase 2 — 音乐库（第一个完整功能面）✅ 已完成

| 步骤 | 产出                                                     | 状态                                                    |
| ---- | -------------------------------------------------------- | ------------------------------------------------------- |
| 2.1  | 三栏 shell + 底部播放条                                  | ✅ 33/33（`scripts/verify-desktop-ui.mjs`）             |
| 2.2  | 音乐库：本地歌单 / B 站收藏夹 / 合集的列表与详情         | 🟡 本地歌单 + 合集已完成；收藏夹在 Phase 3 补上（已通） |
| 2.3  | 搜索（复用多源回退链）                                   | ✅ WBI 签名搜索，20 条结果                              |
| 2.4  | 右键菜单 + 多选 + `Ctrl+F` 搜索                          | 🟡 `Ctrl+F` 已完成；右键菜单与多选未做                  |
| 2.5  | 播放队列面板（右栏）+ 拖拽排序                           | 🟡 队列面板已完成；拖拽排序未做                         |
| 2.6  | 歌词面板（SPL 逐字/翻译/罗马音，复用 `packages/splash`） | 🟡 匹配/解析/DOM 高亮已通；主窗口**行元素不渲染**见 §5  |
| 2.7  | 全局快捷键 registry（3.4 全表）                          | ✅ 19 个已注册                                          |

### Phase 3 — 账号与同步 ✅ 已完成

| 步骤 | 产出                                                          | 状态                                                            |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| 3.1  | 扫码登录（应用内 + 浏览器回跳）、Cookie 粘贴                  | ✅ 三条路：扫码 / 密码 / 粘贴。35/35 UI + 52/52 逻辑            |
| 3.2  | 收藏夹 / 合集订阅与同步（`syncBilibiliPlaylist.ts` 直接复用） | ✅ 收藏夹匿名可读 + **增量**同步（重复导入报「新增 0 跳过 N」） |
| 3.3  | 外部歌单导入（网易云）+ 手动匹配                              | ✅ 后端 65/65 + UI 25/25（QQ 音乐不做，见下）                   |
| 3.4  | 共享歌单（`sharedPlaylist.ts` **按语义重写**，非逐行搬）      | ✅ 契约 95/95 + UI 探针（见下）                                 |
| 3.5  | 播放历史 / 排行榜（`packages/heatmap` 换渲染层）              | ✅ SQL 35/35 + UI 31/31（热力图仍用表格，未换渲染层）           |

#### Phase 3.3 实测结论（外部歌单导入）

**为什么先做网易云、不做 QQ 音乐**：网易云有**匿名可用**的歌单详情接口
（`GET /api/playlist/detail?id=<id>`，不带 cookie 也返回 `code=200`），
一次请求就能拿到全量 `tracks`（含标题/歌手/时长）。QQ 音乐的歌单接口需要
`uin` + 签名（`sign` 由 `songlist` 的 4 段拼接做 zzc 哈希），且**未登录时
拿不到完整列表**，属于「先做登录再谈导入」的量级 —— 因此本阶段只交付网易云，
QQ 留在 §6 明确不做（移动端的 `externalPlaylist` 也只支持这两家，不是新砍的能力）。

匹配是**「网易云歌单 × B 站搜索」的模糊匹配**，不是 id 直接映射（两家没有共同 id）：

1. **权重 `标题 0.5 / 歌手 0.25 / 时长 0.25`**。标题权重最高但**不给满分项**
   —— 单靠标题会出现「同名不同曲」错配。
2. **时长必须能解析**。B 站搜索返回的 `duration` 是 **`"4:21"` 这样的字符串**，
   第一版直接把它喂进 `durationScore`（数值比较），结果是 `NaN` 参与加权，
   **时长这一项恒为 0 分**，权重 0.25 白扔。补了 `parseDuration` 才修好
   （`"1:02:33"` 三段式也要吃下）。网易云那边相反：`duration` 是**毫秒**，
   必须 `/1000`。两个方向的单位差都踩过一次。
3. **B 站的 `author` 是 UP 主，不是歌手** —— 因此 `artistEvidence` 取
   「UP 主名与歌手名的相似度」和「歌手名出现在标题里」两者的**最大值**：
   官方 MV 的 UP 主就是歌手本人（前者命中），搬运号的 UP 主与歌手无关但标题
   会写「歌手 - 歌名」（后者命中）。只用前者会把所有搬运号判为不匹配。
4. **`normalizeArtist` 会把 `/` `、` `,` 等分隔符换成空格**，所以拆分
   `A/B/C` 必须**按空白拆**，不能按原始分隔符拆 —— 后者永远拆不开，
   `artistScore` 恒为 0。这是同一类「权重项静默归零」缺陷的第三次出现。
5. **负向词罚分（`TITLE_PENALTIES`）**：B 站搜索「歌名」的前几名常年是
   **伴奏 / 鼓谱 / 吉他指弹 / 铃声**。实测未加罚分时，
   `如果呢-郑润泽` 的第一名是「高质量和声伴奏」、`我不难过` 的第一名是
   「动态鼓谱」。强负向（伴奏/鼓谱/指弹/纯音乐…）系数 `0.45`，
   弱负向（翻唱/现场/铃声…）`0.85`，同时命中则**叠乘**。
6. **标题证据用「包含」判定**：加了罚分后仍有一批落到 `review` ——
   网易云标题是 `歌名`，B 站标题是 `歌手《歌名》百万豪装录音棚`，
   归一化后的相似度被多余的装饰文字拉低。改为「归一化后一方包含另一方
   → 证据 1.0，否则退化为软相似度」。改完 6/6 样本全部 `auto` 且得分 `1.000`，
   **且没有任何一条是靠罚分才通过的**（有罚分命中会让断言失败）。
   > 这里刻意没有用「分数低于阈值就丢」的强过滤：宁可把 `review` 交给用户
   > 一键确认，也不要静默丢掉一首本来能导入的歌。

修掉的两个真实缺陷：

- **并发匹配循环写出越界下标。** 用户连点两次「开始匹配」会起两个循环，
  两个循环各自把 `selected` 写回同一个数组；先启动、后返回的那个会把
  `selected` 撑到 7（而列表只有 6 项），随后「导入」读到越界下标，
  导出的歌单**少一首且顺序错乱**。加了 `matchingRunId` 守卫（旧 run 的结果
  一律丢弃）并让「只匹配前 N 首」在启动时使进行中的 run 失效。
- **导入结果文案被立刻覆盖。** 与 3.5 的清空历史同一手法：先
  `setStatus('已导入 N 首')` 再 `refresh()`，后者结尾会写成「已加载 N 条」。
  改为先 refresh 再写文案。

**明确记录的未验证项**：匹配的**语义正确性**（自动匹配上的 B 站视频是不是
真的就是那首歌）需要人耳/人眼确认，探针只能断言「分数与负向词符合预期」。
另外 200 首量级的全量匹配 UI 表现（进度、取消、滚动）只做了逻辑断言，
未做真实 200 首的端到端点击验证。

#### Phase 3.4 实测结论（共享歌单）

最初把 3.4 记为「本轮不做，依赖后端 share 接口」。**这个理由是错的** ——
后端 `apps/backend` 是仓库的一部分，而且**公网在线**
（`https://be.bbplayer.roitium.com`，与移动端 `EXPO_PUBLIC_BBPLAYER_API_URL`
的默认值一致），`GET /playlists/:id/preview` 甚至**不需要鉴权**。
摸清之后 3.4 就变成了可做的：桌面端缺的只是一个 BBPlayer 账号客户端。

**它需要第二套身份。** B 站登录态解锁的是 B 站内容（私密收藏夹、会员音轨）；
共享歌单是 BBPlayer 自己后端的能力，有独立的账号与 JWT，两者互不相干 ——
B 站 cookie 拿到共享后端毫无用处。因此 `bbplayer-account.cjs` 与
`bilibili-login.cjs` **并存**，落在不同的文件里。

拿到的几条协议事实（都是读后端代码 + 实测得到的，不是猜的）：

1. **写用 `remove`，读回是 `delete`。** `POST /changes` 的校验器只认
   `op:'remove'`，而 `GET /changes` 返回的 `op` 是 `'delete'`。
   当成同一个词写，会在「拉回来的删除被当成未知 op」处**静默丢掉删除**。
2. **`track_count` 是字符串。** Postgres 的 `count(*)` 经 `pg` 回来是 bigint
   字符串，路由原样透出。断言 `=== 1` 会永远失败。
3. **集合路径不能带尾斜杠。** Hono 的路由是 strict 的：`POST /playlists/` 是
   **404**，`POST /playlists` 才是 201。
4. **JWT 没有 `exp`。** 后端 `sign({sub, role}, secret)` 不传过期时间，
   而且**没有 refresh 端点**。所以客户端不做刷新，401 一律视为「令牌无效」，
   清掉登录态让用户重登 —— 而不是假装能刷新。
5. **LWW 只对曲目操作生效。** `PATCH /playlists/:id`（歌单元数据）**从不比较
   时间戳**，谁最后调用谁赢。客户端能做的是把顺序摆对：`flushOutbox` 按
   `operation_at` **升序**推送，于是同一批里「用户最后做的改动」最后落库 ——
   这是**客户端顺序**给的保证，跨批次的迟到改动仍会无条件覆盖。
   第一版探针拿 `update_metadata` 去测 LWW，失败的是**断言**而不是实现。
6. **邀请码初始是 `null`。** 后端只在 `rotate` 时生成，建共享歌单不会自动生成。
   因此 `GET /:id/invite` 返回 `null` 是**合法状态**，UI 必须能显示
   「还没有邀请码，点这里生成」。

**🔴 时区/时钟：重复拉取是协议的固有性质，不是 bug。** 实测这台 Windows
比 VPS 快约 **10 秒**。后端的 LWW 用**客户端**时间戳（`operation_at` 直接写成
行的 `updated_at`），而增量游标是**服务端**时间，于是刚推上去的行会在
「偏差时长」内持续满足 `updated_at > since`，被重复拉回。这是移动端同样存在的
协议性质。客户端**没有**用一个更激进的游标去掩盖它 —— 那会把「时钟偏差窗口内
别的设备提交的改动」永久漏掉。探针因此断言的是协议真正承诺的东西：
**重放幂等**（不产生重复行、不改变顺序、`item_count` 重算后仍一致）。

**🔴 验证必须对着本地后端跑，不能打生产库。** 上游那个域名是**别人正在服务
的库**，自动化脚本往上面注册账号、建歌单、传曲目、改角色是不可接受的副作用。
因此在 VPS 上用 `wrangler dev` + 本地 Postgres 起了一份一模一样的后端
（systemd 托管，只监听 `127.0.0.1:8787`），Windows 侧用 SSH 隧道接过去。
两个脚本都只认 `BBPLAYER_API_URL`，**隧道不在就直接失败**，绝不静默回退到
生产地址。这也顺带证明了「后端地址可配」这条能力（自建实例是真实需求）。

**桌面端与移动端的处意差异（都是修掉的真问题）：**

- 移动端 `subscribeToPlaylist` 在「本地已有同 `share_id` 的行」时**提前 return**，
  于是「用邀请码升级为协作编辑者」这个按钮**永远不生效**。桌面端把「已存在」
  当成「补发一次 subscribe 请求」：邀请码匹配时服务端会把 subscriber 升成
  editor，这正是用户点那个按钮的意图。探针断言了这条升级路径。
- 移动端拉取时用**重新生成**的 `unique_key` 去查本地曲目
  （`isMultiPage = !!bilibili_cid`），服务端给的键只要和重新生成的差一点就被
  **静默丢弃**。桌面端**以服务端给的 `unique_key` 为准**（它就是身份），
  只在写 `bilibili_metadata` 时解析出 bvid。
- 分享时**静默过滤**没有 bvid 的曲目是移动端的行为（一个纯本地文件的歌单分享
  出去会是空的、用户看不出为什么）。桌面端把跳过条数**如实返回并显示**。
- 后端**没有列出「我订阅的歌单」的增量接口**，`/me/playlists` 只有元数据，
  所以「换设备恢复」要逐个歌单再做一次全量拉取；桌面端与移动端一致。

**顺手修掉的相邻缺陷**：`upsertArtist` 只按 `name` 查然后无条件 INSERT，
一旦同一个 UP **改过名**（或同一首曲目先以名字 A 落库、后又以名字 B 带着同一个
mid 出现）就会撞上 `source_remote_id_unq` **抛异常**，把整批导入打断。
现在带 mid 时先按 `(source, remote_id)` 查 —— mid 才是身份，名字只是显示属性。

**明确记录的未验证项**：多人同时编辑同一歌单时的实际冲突体验（需要两台真机
同时操作）没有人评过；共享 UI 的视觉观感只做了断言与截图，没有人工审美确认。

#### Phase 3.5 实测结论（播放历史）

`play_history` 是共用 schema 里的表，但桌面端此前**只建表、从不写入**
（移动端的 `playHistory.ts` 也查不到调用点）—— 相当于一个静默的空功能。

接上时定的几条语义：

1. **一条记录 = 一次「播放会话」**，不是「一首歌一行」。只留一行会丢掉
   「同一首歌听了 10 次」这个有用信息（「最常播放」要用）。
2. **`duration_played` 取 `MAX` 而不是累加/覆盖**：渲染进程上报的是「本次会话
   累计已播秒数」，取最大值可以容忍乱序与重复上报（暂停后恢复、同一位置被
   上报两次都不会算错）。
3. **「最常播放」只统计 ≥30 秒的会话** —— 否则「点开就切」的误触会把排行冲乱。
   这个阈值与流媒体平台的惯例一致。
4. **「继续收听」的三个条件**：`completed = 0`、已播 ≥10 秒、
   剩余 >15 秒（听到 95/100 秒视为听完）。且同一首歌**只取最后一次会话** ——
   否则「早期听到 150 秒、最后一次只听 30 秒」会显示成 150 秒。
5. **只记录已落库的曲目**：`play_history.track_id` 是外键，而搜索结果的曲目
   还没进 `tracks` 表。缺 `tracks` 行时 `findTrackIdByBvid` 返回 `null`，
   调用方**跳过记录**而不是硬插（后者会被外键拒绝并抛错）。

修掉的两个真实缺陷：

- **并发刷新会渲染出两张表。** 点导航（`show()`）与点页签都会触发 `refresh()`，
  两者都先清空容器再追加内容 —— 慢的那次会把表格追加到快的那次之后。
  加了刷新序号守卫（与 `renderer.js` 里歌词加载的 `lyricsRequestSeq` 同一手法）。
  探针读表头时读到重复的两组列才发现。
- **清空历史的提示文案被立刻覆盖。** `clearHistory` 先写「已清空 N 条」再
  `refresh()`，而后者结尾的 `setStatus('已加载 N 条')` 会把它盖掉，
  用户永远看不到清空结果。改为先 refresh 再写文案。

#### Phase 3 实测结论（都是踩过才写下的）

1. **收藏夹匿名可读** —— 因此「导入收藏夹」**不需要登录**。
   - `GET /x/v3/fav/folder/created/list-all?up_mid=<mid>` 匿名 `code=0`；
   - `GET /x/v3/fav/resource/list?media_id=<id>` 匿名 `code=0`。
   - 登录的价值缩到三处：**私密收藏夹**、会员音轨、个人化推荐。
   - 实测某收藏夹 `media_id = 4026748432`（约 40 亿）——**远超 1e9**。
2. **匿名只有 3 档标准音质**。`fnval=4048` 已声明要杜比与 Hi-Res，但匿名响应里
   `dash.flac` 缺失、`dash.dolby.audio` 为空，只有 `30216 / 30232 / 30280`，
   且带宽随视频而异（46096 / 100395 / 183360）。**会员音轨由登录态决定，
   请求参数再全也没用** —— 所以 `getAudioStream` 的 `enableDolby/enableHiRes`
   默认跟随登录态。
3. **密码登录的公钥是动态的**。`GET /x/passport-login/web/key` 返回
   `{hash, key}`，`key` 是标准 **PEM**，且**每次请求都不同**（服务器持多个
   密钥对）。因此：不再硬编码公钥，`node:crypto.publicEncrypt` 直接用 PEM；
   自写的 BigInt PKCS#1 v1.5 实现保留为兜底。
   明文格式是 **`hash + 密码` 拼接**。
   验证方式（无账号也能验）：用错误凭据调用登录接口，得到
   `code=-105 验证码错误` —— 是**凭据级**错误而不是 `-400 参数错误`，
   证明密文与拼接都被服务端正确解析。这是能做的最强离线验证。
4. **密码登录受风控**，`-105`（要验证码）/ `-106`（要短信）本实现不处理，
   只如实提示改用扫码或粘贴 cookie。本地另加了
   5 次/分钟的限流，避免把账号打进风控。
5. **二维码 URL 的域名是 `account.bilibili.com`，不是 `passport`**
   （之前想当然写成 passport，被断言抓住）。二维码图片在**主进程**生成为
   PNG data URL，渲染进程拿不到 URL 里的 `qrcode_key` —— 已由探针断言。
6. **`remote_sync_id` 不能用算术打包**。两次尝试都被真实数据打脸：
   第一版 `命名空间 + id*1000 + 后缀` 限 `id < 1e9`（40 亿直接抛错）；
   第二版 `命名空间*1e9 + id` 会让 40 亿的收藏夹 id **溢出到合集命名空间**，
   解包成「合集 3026748432」而**静默错包**。最终改为
   **`哈希("fav:<id>")` 写进 `remote_sync_id`，原始 id 存进 `description`
   的 `[[bb:fav:<id>]]` 标记**，解包时从标记读回。这样没有「宽度」这个会失效
   的假设，id 再大也不会溢出；值域取 `[5e15, 5e15+2^48)`，与移动端同步来的
   小整数后端 id 不可能相撞。
7. **凭据落盘的两条分支必须同形**。第一版把「无密钥环」分支写成
   `payload` 里塞一串 JSON，而读取只看 `parsed.cookie` —— 结果是
   **明文模式登录态存进去读不回来**。现在两个分支都摊平
   `cookie/user/savedAt`，并如实标 `encrypted: false` + 一句
   「等同明文」的警告（不静默降级）。
   Windows 下 `safeStorage` 走 DPAPI，实测**可用**（UI 显示「已加密存储」）。

### Phase 4 — 桌面专属能力

| 步骤 | 产出                                            | 状态                                                      |
| ---- | ----------------------------------------------- | --------------------------------------------------------- |
| 4.1  | 独立歌词窗口（无边框透明 + always-on-top）      | ✅ 38/38（`scripts/verify-desktop-lyrics-window.mjs`）    |
| 4.2  | `MediaSession`（媒体键 / 任务栏缩略图 / MPRIS） | ✅ 27/27 + 图标 25/25                                     |
| 4.3  | 下载与导出（主进程 `fs`，比移动端简单）         | ✅ 下载 34/34；导出只做「下载落盘」，不做格式转换         |
| 4.4  | 主题换肤（保留配色，砍视频开屏）                | ✅ 深色 / 浅色（浅色只覆盖语义 token）                    |
| 4.5  | WebDAV 备份 / 恢复（**必须与移动端格式互通**）  | ✅ 备份 48/48 + WebDAV 28/28（真实回环 WebDAV 服务器）    |
| 4.6  | 定时关闭、响度均衡                              | ✅ 定时关闭含淡出与音量还原；响度均衡为**基于电平**的近似 |

#### Phase 4 实测结论（都是踩过才写下的）

1. **`navigator.mediaSession` 在 Electron 里直接可用**，Windows 对接 SMTC、
   Linux 对接 MPRIS —— 不需要写任何原生代码。但有两个坑：
   - Electron 默认可能把媒体键吃在应用菜单快捷键上，需要
     `webContents.setIgnoreMenuShortcuts(true)` 把按键让给 MediaSession；
   - `globalShortcut` 兜底与 MediaSession **同时生效会双触发**
     （播放→暂停→播放，表现为「按了没反应」），所以兜底默认**关闭**，
     只在 `--media-keys` 下启用。`globalShortcut` 在 Wayland 上通常无效。

2. **`setPositionState` 的 duration 为 `NaN`/`0`/`Infinity` 时会抛错**（规范
   要求）。曲目刚加载、时长未知时直接调用会不断抛异常，必须先过滤。

3. **`MediaMetadata` 的去重不能只看封面**。第一版用「封面 URL 是否变化」去重，
   于是**连续两首都没有封面**时 `null === null` 成立、直接 return，系统面板会
   一直显示第一首的标题。指纹必须覆盖标题/作者/封面。此 bug 由
   `verify-desktop-media.mjs` 的「切换曲目后元数据已更新」断言抓到。

4. **下载的 `.part` 续传必须显式传写入位置**。只写 `fs.writeSync(handle, chunk)`
   会依赖文件游标，而 `ftruncateSync` 把游标留在末尾 —— 续传时首个 chunk 被写到
   `startByte` 而不是 0，结果文件「前半段是空洞 + 后半段是数据」且长度不足。
   由 `verify-download.mjs` 的「续传后逐字节相同」断言抓到。

5. **上游中途断开时 Node 的 fetch 抛 `TypeError: terminated`**，对用户毫无意义。
   需要翻译成「下载中断：已收到 N 字节，期望 M 字节」，**保留 `.part`** 供重试，
   同时**不能**生成成品文件（否则用户以为下好了）。

6. **B 站的 `backupUrl` 值得用**。移动端的下载只读 `baseUrl`（`backup_url`
   解析了但从不使用）；桌面端逐个尝试主/备用地址，减少「某个 CDN 节点抽风就
   整首失败」。实测同一逻辑下主节点 500、备用节点正常。

7. **`.m4a` 不需要转码**：dash 音频是 `.m4s`，而 m4s 与 m4a 同为 ISOBMFF
   容器，改扩展名即可播放（移动端也是这么做的）。因此桌面端**不引入 ffmpeg**，
   省掉几十 MB 体积与签名麻烦。

#### 备份与移动端互通（🔴 三个会静默毁数据的陷阱）

移动端的备份**不是 JSON 记录级导出**，而是**一个 ZIP，内含原始 SQLite 快照**
（`apps/mobile/src/lib/backup/export.ts`）：

```
backup-<ISO 时间戳，冒号与点都换成 ->.bbplayer
  ├── database.db     VACUUM INTO 的原始字节（不压缩 —— JSZip 默认 STORE）
  └── manifest.json   {"version":2,"exportedAt":…,"mmkv":{…},"orpheus":{…}}
```

远端文件名**必须**匹配 `/^backup-.+\.bbplayer$/`，否则移动端列不出来。目录默认
`/BBPlayer`。移动端**没有删除/保留策略**（它的 WebDAV 适配器压根没有
`deleteFile`），所以桌面端也不清理，不引入移动端没有的行为。

**🔴 H1：`__drizzle_migrations` 两端结构不同。** `VACUUM INTO` 会把迁移日志
复制进快照，于是「谁生成的备份」决定表结构：

| 生成方                     | 表结构                                             |
| -------------------------- | -------------------------------------------------- |
| 移动端（drizzle migrator） | `(id SERIAL, hash text, created_at numeric)`       |
| 桌面端（手写 runner）      | `(id TEXT, applied_at INTEGER)`，`id` 存迁移文件名 |

两个方向都会炸：移动端备份在桌面恢复 → 桌面 runner 拿到整数 id，永不等于文件名
→ 重放 `0000_baseline.sql`，而它**一个 `IF NOT EXISTS` 都没有** →
`table artists already exists`；桌面端备份在移动端恢复 → drizzle 查 `created_at`
→ `no such column: created_at` → 迁移失败。**处理**：导出时规范成移动端形状
（并记为「已应用全部迁移」，让 drizzle 无事可做），导入时规范成桌面形状
（并把基线记为已应用）。

**🔴 H2：五个 JS 数据迁移此前只在移动端跑过。** `migrateSortKeysV2/V3`、
`migratePlayHistory`、`migrateIndependentAccountReset`、`migratePlayHistoryToMs`
由移动端 `useFastMigrations.ts` 调用，桌面端从不调用 —— 于是桌面生成的库里
`sort_key` 等字段可能没被规范化。**处理**：恢复时调用它们（幂等，由
`__bbplayer_data_migrations` 记账）。

⚠️ 调用它们时必须把 core 的**端口临时重指**到正在处理的那个库：核心迁移函数从
端口注册表取数据库（不是从参数），而恢复流程已经关掉了活跃库的连接。第一版因此
让五个迁移全部报「数据库已关闭」，只是被「单个迁移失败不阻断整体」的容错吞掉了
（探针把这条断言抓了出来）。

**🟡 H3：`manifest.orpheus` 必须存在。** 移动端 `import.ts` 是
`Orpheus.importData(manifest.orpheus)`，**没有判空**，而 Kotlin 签名是
`Map<String, Any>` —— 缺字段会在原生参数转换处失败。桌面端没有 Orpheus，
固定发 `{playerQueue:{},loudness:{}}`。

**🔴 H4：`playlist_tracks.sort_key` 的**方向**两端相反（已修）。**
两端各自实现过一次顺序键，而且实现了相反的方向：

|                | 生成                                     | 读取                     |
| -------------- | ---------------------------------------- | ------------------------ |
| 移动端         | fractional-indexing，**越靠前键越大**    | `ORDER BY sort_key DESC` |
| 桌面端（修前） | `` `a${index 补零}` ``，**越靠前键越小** | `ORDER BY sort_key ASC`  |

两端**各自自洽**，所以单端怎么点都看不出问题 —— 但备份是「整个 SQLite 文件
搬家」，移动端拿到桌面端的库后按 `DESC` 读，**整单倒过来**。

更隐蔽的一点：移动端的 `sortKeysV3` 数据迁移**只翻转 `type != 'local'` 的歌单**
（它自己的 local 歌单从一开始就是 fractional 约定）。于是桌面端「导入的收藏夹/
合集」在导出时会被翻转成对的，而**桌面端自己新建的 local 歌单不会被翻转** ——
恰好是最常见的那一类。这个 bug 藏在「已经修好一个方向」的假象里。

**处理**：

1. 顺序约定抽进 `packages/core/src/utils/sortKey.ts`，两端**共用一份实现**
   （顺序是跨端数据格式的一部分，不能各写一份）；
2. 桌面端改成 fractional 键 + `DESC` 读取，并保留「新加的落在末尾」这个
   用户可见行为（`generateKeyForBottom`）；
3. 启动时做一次性数据迁移 `sort_key_desktop_v1`，把旧键按**升级前显示顺序**
   重写 —— **按歌单逐个判断键的形状**（全是 `^a\d{6}$` 才重写），不是只看记账表。
   恢复备份会整体替换数据库文件、连记账表一起换掉，只看记账表的话，把**移动端**
   的备份恢复到桌面端会被误判成「没迁过」而把已经正确的键再排一遍，**恰好倒序**；
4. 同时把 core 的 `sort_key_v3` 记为已完成 —— 桌面端这一次迁移对**全部**歌单
   建立了同一个不变式，而导出时 `backup.cjs` 会在副本上调用 `sortKeysV3`，
   不记账的话它会再翻一次，把**已经正确**的非 local 歌单翻坏。
   记账表的含义是「该不变式已成立」，不是「这段代码逐行执行过」。

验证：`scripts/verify-sortkey-interop.mts`（16 项）。它刻意**调用桌面端的真实
实现**（`db.getPlaylistTracks`）而不是重写一遍 SQL —— 脚本自己实现读法的话，
实现改成什么样脚本都自洽，等于什么都没测。覆盖：两端对拍、键的取值方向、
`migrateSortKeysV3` 变成 no-op、追加落末尾、**旧库升级后顺序不变**、fractional
键的可插入性（未来拖拽排序的前提）。

**恢复后必须重启应用**：Windows 上打开着的文件不能被 rename（实测 `EBUSY`），
所以恢复前必须关掉数据库连接，之后本进程不能再访问数据库。这与移动端一致
（它也先 `closeSync()` 再换文件并要求重启）。桌面端为此加了断路器：关闭后任何
访问都抛「需要重启应用」，而不是让调用方拿到一个「读到旧内存页」的连接。

### Phase 5 — 打包发布

| 步骤 | 产出                                                                      | 状态                                                              |
| ---- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 5.1  | `electron-builder`：Windows NSIS + portable、Linux `.deb`/`.rpm`/AppImage | ✅ 三种 Linux 格式 + 两种 Windows 格式均已构建并在真机验证        |
| 5.2  | `apps/update-publisher` 支持桌面产物（**当前只收 `.apk`**，见 §5 风险 3） | ✅ 按 electron-updater 路线实现（见下，**不**扩展 `update.json`） |
| 5.3  | 各自签名策略                                                              | ⬜ 未做（未签名，Windows SmartScreen 会提示，属已知取舍）         |
| 5.4  | 桌面端独立版本号，从 `0.1.0` 起步（mobile 当前 `2.7.0-alpha.1`）          | ✅ `apps/desktop/package.json` 为 `0.1.0`，与移动端版本线完全独立 |

#### Phase 5 实测结论

**构建产物（已在真机验证）**

Phase 3.4 之后全部重验过一遍。Windows 由
`scripts/verify-win-installer.mjs`（12 项，`pnpm verify:win-installer`）
自动跑完装/卸全程；Linux 由 `severs/vps-verify-linux.sh` 在 VPS 上一键跑完。

| 平台    | 产物                                            | 大小     | 验证                                                                             |
| ------- | ----------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| Windows | `BBPlayer-0.1.0-win-x64-nsis-setup.exe`         | 99.3 MB  | `/S` 静默安装 → 对**装出来的那个 exe** 跑自检 24/24 → `/S` 静默卸载（目录清空）  |
| Windows | `BBPlayer-0.1.0-win-x64-portable.exe`           | 99.1 MB  | 启动并在临时 userData 里建出 12 张表 + 三条 sort_key 记账（见下：拿不到 stdout） |
| Linux   | `BBPlayer-0.1.0-linux-amd64.deb`                | 100.4 MB | `apt-get install` 自动解依赖（**依赖清单含 `libasound2`**）→ 自检 → purge 干净   |
| Linux   | `BBPlayer-0.1.0-linux-x86_64.rpm`               | 88.2 MB  | `rpm -ivh` → 依赖含 `alsa-lib` → `rpm -e`（0 个文件残留）                        |
| Linux   | `BBPlayer-0.1.0-linux-x86_64.AppImage`          | 129.3 MB | `--appimage-extract-and-run` 自检通过                                            |
| 两者    | `latest.yml` / `latest-linux.yml` + `.blockmap` | —        | electron-updater 的 feed 与增量更新块                                            |

**⚠️ portable 拿不到子进程 stdout。** electron-builder 的 portable 是 NSIS
自解压启动器：它**解包后 detach 子进程**，于是 `spawnSync` 立刻以 0 退出，
而应用还在跑。第一版验收脚本因此误判成「portable 没输出自检结果」——
错的是**取证方式**，不是产物。改成把 userData 指到一个空目录、等它把数据库
建出来后**直接打开那个库**检查表与迁移记账，这样既证明产物真能启动，
也证明包内的 core、基线迁移与 `sort_key` 数据迁移都生效。

**⚠️ rpm 的包名是 `BBPlayer`（来自 productName），不是 `bbplayer`。**
第一版 Linux 验收脚本写成 `rpm -e bbplayer`，卸载**静默失败**，于是上一次装的
rpm 还在，下一次 `rpm -ivh` 直接报 file conflicts。同样是脚本的错，不是产物的错。
`rpm -e` 之后会留下两个**空目录**（`/opt/BBPlayer/{locales,resources}`），
文件数为 0 —— 这是 electron-builder 的 rpm spec 行为，如实记下。

**只有真机才能发现的问题（都在 Linux 上暴露）**

1. **`executableName` 从包名派生会得到非法名。** Linux 上它默认取
   `package.json` 的 `name`，而我们是 pnpm 作用域包 `@bbplayer/desktop`
   → `@bbplayerdesktop`，AppImage 直接拒绝：
   `contains characters that cannot be safely used in file paths`。
   **Windows 用的是 productName，所以这个坑只在 Linux 暴露。**
   显式设 `linux.executableName: bbplayer` 解决。

2. **deb/rpm 需要 `package.json` 里有 `homepage`。** 缺了 fpm 直接失败：
   `Please specify project homepage`。AppImage 不需要，所以排在它后面的
   deb/rpm 才报错。

3. **electron-builder 的默认依赖清单不含 ALSA。** 最小化安装的 Linux 上
   启动时报 `error while loading shared libraries: libasound.so.2`。
   一个**音乐播放器**没声明 ALSA 依赖说不过去，已显式补上
   `libasound2`（Debian）/ `alsa-lib`（RPM）。

4. **`artifactName` 里不能用 `${target}`。** electron-builder 的可用宏只有
   `${productName}` `${version}` `${arch}` `${ext}` `${os}` `${channel}`。
   而 `.exe` 在 NSIS 与 portable 之间**有歧义**，所以在各 target 下分别
   声明 `artifactName`（`-nsis-setup` / `-portable` 后缀）——这同时也是
   `update-publisher` 能正确分类的前提。

**关于更新机制：桌面端走 electron-updater，不扩展 `update.json`**

计划文档早已指明这一点（§2.4、§3.5、§6）。调研进一步核对源码后确认，
合并两条通道是**做不到**的：

- 移动端 `updateService.ts` 的 `parseDownloads` **只读 `downloads.android`**，
  其它键被静默丢弃；
- `update.json` 只有一个全局 `version` 与一个 `url`，而桌面端是独立版本线
  （`0.1.0`）与移动端（`2.7.0-alpha.1`）无法共用一个 version；
- 移动端拿这个 version 与**自己**的原生版本比较，把桌面版本写进去会得出
  「有 0.1.0 更新」而自己的 2.7.x 更大 —— 逻辑上直接矛盾。

所以 `update-publisher` 对桌面端做的是**收集 / 校验 / 报告**，其中
**校验是真价值**：读 `latest*.yml` 并核对每个文件的 `sha512` 与 `size`
是否与实际文件一致 —— 这正是 electron-updater 更新时会核对的两项，对不上
它会拒绝更新，而那时往往已经发过版了。实测：往安装包尾部追加 100 字节，
两项都被抓到、退出码 1。

---

## 5. 风险与对策

| #   | 风险                                                                                                                                                              | 等级      | 对策                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------- |
| 1   | **B 站音频防盗链导致播不了**（`NetworkModule.kt:42-45`）                                                                                                          | 🔴 高     | Phase 1.3 作为 go/no-go 关卡；自定义协议代理                  |
| 2   | 33k 行 UI 重写的工作量被低估                                                                                                                                      | 🔴 高     | 明确「不是移植」；Phase 2 只做核心三页，其余迭代补            |
| 3   | **`apps/update-publisher/src/index.ts:211` 只收 `.apk`**（`if (!asset.name.toLowerCase().endsWith('.apk')) continue`），`:252` 硬编码 `/Applications/Zed.app/...` | 🟡 中     | Phase 5.2 改造发布工具，否则桌面安装包进不了更新清单          |
| 4   | 歌词服务剥离（625 行 + `Orpheus` 推送）                                                                                                                           | 🟡 中     | 抽出「匹配/缓存/偏移」，推送通过 `AudioPort` 可选方法         |
| 5   | 两套 UI 长期漂移                                                                                                                                                  | 🟡 中     | `packages/design-tokens` 单一来源 + 共享 `packages/core` 契约 |
| 6   | 打包体积（Electron ~120 MB）                                                                                                                                      | 🟢 低     | 接受；或用 `asar` + 裁剪依赖压到 ~90 MB                       |
| 7   | mobile 回归                                                                                                                                                       | 🟡 中     | Phase 0 每步都跑 `pnpm type-check` + `pnpm lint`；CI 门禁     |
| 8   | ~~`pnpm install` 未执行，Phase 0 无法验证~~                                                                                                                       | ✅ 已解除 | 依赖已安装（两个 `packages` 已建链）                          |
| 9   | **lefthook `pre-commit` 钩子在 Windows 上不可用**（实测复现，非推测）                                                                                             | 🟡 中     | 见下方「lefthook 缺陷详情」；在 Linux/macOS 上不受影响        |

### lefthook 缺陷详情与最终方案（已解决）

提交 Phase 0 时钩子失败，定位到 `lefthook.yml` 的三个真实缺陷：

1. **lefthook 的 `{...}` 模板语法会破坏脚本正文里的 shell 变量展开**。
   实测 `files=({staged_files})` 之后的 `${#files[@]}` 被替换成 `0files[@]`，
   脚本随即语法错误。凡是在 `run` 里写 `${...}` 都有此风险。
2. **`{staged_files}` 展开时不加引号**，因此文件名里的括号（本仓库有
   `app/(tabs)/index.tsx`、`app/comments/[bvid].tsx` 等）会让
   `files=(...)` 这类数组赋值直接语法错误。
3. **`run` 脚本由 `sh` 执行（Windows 上是 `cmd`）**，两个平台行为不一致。

**最终方案：把全部钩子逻辑搬到 Node，`lefthook.yml` 只保留一行调用。**

```yaml
pre-commit:
  commands:
    checks:
      run: node scripts/precommit.mjs
```

`scripts/precommit.mjs` 负责：gitleaks 密钥扫描（未安装则跳过）、`oxfmt --write`、
`oxlint --type-aware`、以及**把格式化结果重新暂存**（等价于原 `stage_fixed: true`）。

关键实现细节（都是踩坑换来的）：

- 暂存文件用 `git diff --cached --name-only --diff-filter=ACMR -z` 读取，路径不经 shell。
- **不能**用 `pnpm exec oxfmt`：Windows 上 `pnpm` 是 `pnpm.cmd`，必须经 `cmd.exe`，
  而 `cmd.exe` 会把参数里的 `()` 当分组符号（实测报
  `…/index.tsx was unexpected at this time`）。改为用 `node node_modules/oxfmt/bin/oxfmt`
  直接执行，彻底不经 shell。
- 移植到 Windows 时 `spawnSync('pnpm', …, { shell: false })` 会 ENOENT（`.cmd` 不可直接执行）。

**验证方式**：真实执行 `git commit`（不加 `--no-verify`），钩子在暂存区含
`app/(tabs)/index.tsx` 这类路径的情况下通过了 gitleaks/oxfmt/oxlint 三项，
且格式化结果被正确纳入提交（提交后工作区干净）。

相应提交：`883cbbb5`（搬进 Node 脚本）、`968011f6`（补上重新暂存）。

---

## 6. 明确不做的

| 砍掉                                                            | 原因                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 开屏视频动画（`AnimatedBootSplash.tsx`、`BootSplashVideoView`） | Android 原生视图；桌面用静态启动图                                     |
| 状态栏歌词（SuperLyric / Lyricon / 魅族，`lyrics.tsx:261,279`） | 无桌面对应物，由 `MediaSession` 替代                                   |
| 车机歌词 / `isCarLyricsEnabled`                                 | 面向 Android Auto                                                      |
| APK 自更新（`UpdateAppModal.tsx`）                              | 由 `electron-updater` 替代                                             |
| 冷启动测量脚本（`measure-cold-start.sh`）                       | Android `adb` 专属                                                     |
| 移动端分享到系统（二维码 / 存相册）                             | 改复制链接 + 导出分享图                                                |
| `react-native-web` / `react-native-windows` 路线                | 12 个 Android-only 依赖 + `.web.*` 文件数为 0                          |
| macOS 产物                                                      | 按当前范围只做 Win/Linux；代码天然三平台中立，将来加 target + 签名即可 |
| QQ 音乐歌单导入                                                 | 接口需 `uin` + zzc 签名，**未登录拿不到完整列表**；本轮只交付网易云    |

---

## 7. 验收标准

**Phase 0 完成时**：

- `apps/mobile` 的 `pnpm type-check` / `pnpm lint` / 现有 jest 全绿，**零行为变更**
- `packages/core` 里 import `react-native` 会编译失败
- CI 能在 PR 上拦住边界违规

**Phase 1 完成时**：

- Windows 与 Linux 上都能启动 Electron 壳
- 能真实播放一首 B 站音频并拖动 seek
- 能从 B 站拉歌单落进本地 SQLite

**Phase 3 完成时**（✅ 已达成）：

- 登录三条路可用：扫码 / 密码 / 粘贴 cookie，cookie **从不到达渲染进程**
- 凭据落盘加密（Windows DPAPI 实测可用），无密钥环时**如实告知**而非静默降级
- 公开收藏夹**无需登录**即可列出、预览、导入
- 重复导入是增量的（第二次报「新增 0，跳过 N」）—— 断言见
  `scripts/verify-desktop-login.mjs`
- 无效凭据 / 风控错误被如实拒绝并给出可执行的下一步
- 外部歌单导入：链接 / 纯 id / 分享文案都能解析，匹配分数与负向词符合预期，
  重复导入幂等，单首失败不污染整单 —— 断言见
  `scripts/verify-external-import.mts`（65 项）与 `scripts/verify-desktop-import.mjs`（25 项）
- 共享歌单：预览**不需要登录**；订阅落库保持顺序；本地改动进 outbox 并推送；
  增量拉取重放幂等；owner / editor / subscriber 三种角色的权限**各自被断言**
  （订阅者的写操作既不推也不入队）；取消共享区分「删远端」与「退出协作」；
  验证**只打本机后端**，隧道不在就失败 —— 契约见
  `scripts/verify-shared-playlist.mts`（95 项），界面见 `scripts/verify-desktop-shared.mjs`
- **明确记录的未验证项**：扫码的最后一跳（手机确认）只有真人能做，
  探针把它记为「待人工验证」，**不冒充通过**；外部歌单匹配的**语义正确性**
  同理，只断言分数不冒充「匹配对了」；共享歌单的多人同时编辑体验需要两台
  真机同时操作，只断言了协议层的 LWW 与重放幂等

**整体完成时**：

- Windows `.exe` 与 Linux `.deb`/AppImage 可安装运行
- 核心路径（播放 / 搜索 / 歌单 / 歌词 / 同步 / 备份）行为与移动端一致
- 备份文件与移动端互通
