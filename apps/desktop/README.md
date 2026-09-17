# BBPlayer Desktop（Electron）

Windows / Linux 桌面端。当前处于 **Phase 1：骨架 + 可行性验证**。

方案与阶段划分见 [`docs/DESKTOP_PLAN.md`](../../docs/DESKTOP_PLAN.md)。

---

## 这个骨架验证了什么

Phase 1 的 go/no-go 关卡是「Electron 到底能不能播 B 站音频」。**结论：能，且已自动化验证。**

```
node scripts/verify-desktop.mjs
```

18 项断言全部通过（最近一次运行）：

| 验证项                            | 结果                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| 自定义协议 + `<audio>` 加载元数据 | ✅ `readyState=3`，时长 212.31s                                     |
| 真正开始播放                      | ✅ 时间推进 0.02s → 2.52s                                           |
| 拖动 seek                         | ✅ 3.27s → 30.03s                                                   |
| 上游 CDN 响应                     | ✅ **206**（`Referer` 注入生效，否则 403）                          |
| 代理透传 Range（严格测试）        | ✅ `Content-Range: bytes 1000000-1001023/5408198`，只回传 1024 字节 |
| 严格 Range 测试                   | ✅ 完整通过                                                         |
| 解码缓冲建立                      | ✅ `buffered [[0, 130.54]]`                                         |
| 全程无媒体错误                    | ✅                                                                  |

验证脚本会把截图写到 `probe-output/shots/`，报告写到 `probe-output/report.json`。

---

## 为什么必须走主进程代理

实测（`node scripts/probe-bilibili-audio.mjs`，3 视频 × 3 地址 = 9 样本）：

| 节点类型         | 样本 |  裸请求 | 带 Referer+UA | Range 206 | 带 ACAO |
| ---------------- | ---: | ------: | ------------: | --------: | ------: |
| **upos（主线）** |    5 | **0/5** |           5/5 |       5/5 | **0/5** |
| other            |    2 |     0/2 |           2/2 |       2/2 |     2/2 |
| PCDN（`mcdn.*`） |    2 |     2/2 |           2/2 |       2/2 |     2/2 |

两个结论决定了架构：

1. **主线 CDN 检查 `Referer`** —— 裸请求 403。渲染进程无法自行加这个头。
2. **主线 CDN 不返回 `Access-Control-Allow-Origin`** —— 渲染进程直接
   `<audio src="https://…bilivideo.com/…">` 会被 CORS 拦。

所以音频必须由主进程代发请求。这里用自定义协议 `bbplayer-audio://`：
渲染进程只拿到本协议地址，主进程负责注入请求头、透传 Range、流式回传。
**不需要 `webSecurity: false`。**

> 注意：PCDN 节点（`mcdn.bilivideo.cn`）会放行裸请求。第一版探测只测到一个
> PCDN 地址，因此得出过「不需要代理」的错误结论 —— 不要在单样本上下结论。

---

## 目录结构

```
apps/desktop/
  package.json
  src/
    main.cjs           主进程：注册特权协议、创建窗口、IPC
    preload.cjs        contextBridge：只暴露必要能力
    audio-proxy.cjs    bvid 解析 + bbplayer-audio:// 代理实现
    probe-driver.cjs   自动化验证序列（截图 + 点击级断言）
    renderer/
      index.html       验证界面
      style.css        M3 深色配色（token 取自 packages/design-tokens）
      renderer.js      播放控制 + window.bbTest 自验证接口
```

## 运行

```bash
# 首次需要下载 Electron 二进制（约 142 MB）
cd node_modules/.pnpm/electron@*/node_modules/electron && node install.js

# 手动运行（会开一个窗口）
pnpm --filter @bbplayer/desktop start

# 自动化验证（无人工介入，跑完自动退出）
node scripts/verify-desktop.mjs
```

国内网络下载 Electron 可用镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js
```

---

## 两种方案的实测对比

Phase 1 对比了「自定义协议代理」与「`webRequest` 注入头 + 渲染进程直连」两条路。

`node scripts/compare-audio-strategies.mjs`（`COMPARE_ROUNDS` 控制轮数）

| 方案                            | 结果                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **A. 自定义协议代理**（已采用） | ✅ 可用。`verify-desktop.mjs` 18/18 通过                                                                       |
| B. `webRequest` 注入 + 直连 CDN | ❌ **7/7 全部失败**，`MEDIA_ELEMENT_ERROR: Format error`；关掉 `webSecurity` + `--disable-web-security` 也一样 |

**失败原因不是 CORS**（这一点很重要，早先的推断是错的）：

| 观测                                    | 结果                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 渲染进程 `fetch()` 同一地址（带 Range） | ✅ 7/7 成功：206、`video/mp4`、`Content-Range: bytes 0-1023/5408198`，首字节 `00 00 00 24 66 74 79 70`（合法 MP4 "ftyp"） |
| 渲染进程 `<audio>` 播同一地址           | ❌ 7/7 失败，`readyState` 停在 0                                                                                          |

即**渲染进程能拿到数据，但媒体加载器不接受这些 CDN 地址**。所以必须走代理。

排查过程中踩到一个自己挖的坑：`renderer/index.html` 最初只声明了 `media-src`、
没声明 `connect-src`，导致 `fetch` 被 CSP 拦下，被误读成 CORS 问题。补上
`connect-src` 后 `fetch` 立刻正常，但 `<audio>` 依然失败——两个问题才被分开。

> 关于这个 CDN：**单样本结论已经错了两次**。第一次是 PCDN 节点放行裸请求；
> 第二次是某一次 Case A 偶然成功。所以对比脚本默认跑多轮，只看成功率。

---

## 已知限制 / 下一步

- 这个骨架**只做播放验证**，没有接 `packages/core`（Phase 2 才接）。
- 用的是 B 站公开的 `view` + `playurl` 接口，**未处理 WBI 签名与登录态**，
  因此音质受限。完整实现应复用 `packages/core` 的
  `lib/api`（含 WBI 签名）与端口注入。
- 播放引擎是渲染进程的 `<audio>`，尚未实现 `AudioPort` 接口
  （见 `packages/core/src/ports/index.ts`），Phase 2 对齐。
- `window.bbProbe` 自验证通道目前无条件暴露，生产化时要加开关或移除。
- `installNetworkTracer()` 目前抓不到 `<audio>` 的请求（`webRequest.onCompleted`
  似乎不覆盖媒体加载器的请求），所以「媒体加载器到底收到什么」仍未查明。
  **不影响结论**（A 可用、B 不可用已由播放结果本身证明），但若将来要深究 B 的
  失败机制，这里需要换一种追踪方式（如 CDP Network 域）。
