# BBPlayer Desktop（Electron）

Windows / Linux 桌面端。**Phase 0–3 已完成**，下一步是 Phase 4（桌面专属能力）
与 Phase 5（打包发布）。

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
# 仅需 Node
node scripts/verify-desktop.mjs          # 18 项：真实播放 / seek / Range 透传
node scripts/verify-desktop-ui.mjs       # 33 项：三栏 shell / 导入 / 播放 / 快捷键 / 搜索 / 歌词
node scripts/verify-desktop-login.mjs    # 35 项：登录三条路 / 收藏夹 / 增量同步
node scripts/verify-bilibili-login.mjs   # 需 tsx：52 项（含离线纯函数 + 真实接口）

# 需要 tsx（core 是 TS + 无扩展名 ESM，纯 node 跑不了）
pnpm exec tsx scripts/verify-core-on-node.mjs
pnpm exec tsx scripts/verify-bilibili-api.mts
pnpm exec tsx scripts/verify-lyrics.mts
pnpm exec tsx scripts/verify-desktop-db.mts
pnpm exec tsx scripts/verify-bilibili-login.mts
```

⚠️ **跑 Electron 类验证前先清掉遗留进程**，否则探针会静默失败：

```powershell
Get-Process -Name electron -ErrorAction SilentlyContinue | Stop-Process -Force
```

### Phase 3 的验证边界（重要）

扫码登录的**最后一跳需要真人用手机确认**，自动化到不了。因此
`verify-desktop-login.mjs` 把这类项记为 **「待人工验证」**，既不算通过也不算
失败，并在输出里显式列出——**不用「状态正确」掩盖「没验证」**。

设置 `BILIBILI_TEST_COOKIE` 后，探针会额外自动验证「登录后的行为」
（会员音轨、私密收藏夹）。

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
    ipc-handlers.cjs          全部 IPC handler
    ipc-handlers 之外的探针：probe-driver / ui-probe-driver /
                            compare-driver / login-probe-driver
    renderer/
      index.html  style.css  state.js  player.js  library.js
      keyboard.js  lyrics-panel.js  auth.js  favorites.js  renderer.js
```

### 为什么数据库 schema 与移动端同源

建表 SQL 来自 `drizzle-kit` 从 `packages/core/src/db/schema.ts` 生成的
**单文件基线** `drizzle/0000_baseline.sql`（9 张表 + 全部索引/外键）。

上游那套增量迁移链**在空库上跑不通**：`0002_groovy_maximus.sql` 去读
`artists.source` / `artists.remote_id` / `playlists.remote_sync_id`，而这几个列
**没有任何迁移创建过**（全仓搜索确认），跑到 0002 必然
`no such column: "source"`。基线方案保证最终结构与移动端一致，因此 Phase 4 的
备份互通仍然成立。

`apps/desktop/drizzle/` 与 `apps/mobile/drizzle/` 是**两条独立的链**，
只保证最终结构一致，不保证迁移历史一致。

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

- **`window.bbProbe` 无条件暴露**，生产化前必须加开关或移除。
- 渲染进程**没有实现 `AudioPort`**：播放仍直接用 `<audio>` + 自定义协议。
  `packages/core/src/ports/index.ts` 里的 `AudioPort` 尚未接入，Phase 4 对齐。
- **歌词面板的已知缺陷（未定位）**：主界面里 `setLyrics(48)` 状态正确、
  `data-active` 也写进 DOM，但**行元素不渲染**（`li` 为 0、`meta` 显示
  `— / 0`）。同一面板在独立的 `lyrics-lab.html` 里 30/30 通过，所以问题在
  「主界面集成」这一层。详见 [`docs/LYRICS.md`](../../docs/LYRICS.md) §6。
  验证脚本把它记为**警告**而不是通过 —— 不用「状态正确」掩盖「DOM 没渲染」。
- **打包**：Windows 上只有 `--linux dir` 与 `--linux tar.gz` 能出；
  `deb`/`rpm` 报 `spawn fpm ENOENT`，AppImage 报 `mksquashfs ENOENT`。
  正式 Linux 包需要 Docker 或 Linux runner（计划用 VPS）。
- Phase 3 的 3.3（外部歌单导入）/ 3.4（共享歌单）/ 3.5（播放历史）本轮**不做**。
