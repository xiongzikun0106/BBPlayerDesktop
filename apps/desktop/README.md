# BBPlayer Desktop（Electron）

Windows / Linux 桌面端。**Phase 0–5 已完成**：播放 / 搜索 / 歌单 / 歌词 / 登录同步 /
下载 / WebDAV 备份 / 媒体集成 / 独立歌词窗口 / 主题 / 定时关闭 / 响度均衡，
并且 Windows 与 Linux 的安装包均已构建并在真机验证。

未做的只有 Phase 5.3（代码签名）与 Phase 3.3–3.5（外部歌单导入 / 共享歌单 / 播放历史）。

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
pnpm verify:desktop:icons      # 25 项：任务栏图标生成器
pnpm verify:desktop:download   # 34 项：下载 / 续传 / 完整性 / 并发
pnpm verify:backup             # 48 项：备份格式与移动端互通
pnpm verify:backup:webdav      # 28 项：真实回环 WebDAV 服务器
pnpm verify:login              # 52 项：登录接口与 RSA 加密链路

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
    ipc-handlers.cjs          全部 IPC handler
    探针：probe-driver / ui-probe-driver / compare-driver /
          login-probe-driver / media-probe-driver
    renderer/
      index.html  style.css  state.js  player.js  library.js
      keyboard.js  lyrics-panel.js  media-session.js
      lyrics-window.html  lyrics-window.css  lyrics-window.js
      desktop-features.js  settings-panel.js
      auth.js  favorites.js  renderer.js
```

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
- Phase 3.3（外部歌单导入）/ 3.4（共享歌单）/ 3.5（播放历史）未做。
- 歌词窗口的「锁定」只做到不可拖动；真正的鼠标穿透需要
  `setIgnoreMouseEvents`，属于另一个交互决策。
