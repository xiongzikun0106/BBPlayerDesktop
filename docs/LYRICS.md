# 桌面端歌词功能

本文记录桌面端（`apps/desktop`）歌词模块的实现：数据来源、匹配算法、如何单独验证，
以及已知限制。

## 1. 模块划分

| 文件                                                              | 职责                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/core/src/api/netease/lyrics.ts`                         | 网易云歌词客户端（搜索 / 取词），走 `getCorePorts().http` |
| `packages/core/src/services/lyricMatcher.ts`                      | 候选匹配打分（**纯逻辑**，不碰网络、不碰端口）            |
| `packages/splash`（已有）                                         | LRC / SPL 解析与「主歌词 + 翻译 + 罗马音」合并            |
| `apps/desktop/src/renderer/lyrics-panel.js`                       | 歌词面板 UI（纯 Web，无框架，接收数据的纯 UI 模块）       |
| `apps/desktop/src/renderer/lyrics-panel.css`                      | 面板样式（变量自带兜底值，可独立使用）                    |
| `apps/desktop/src/renderer/lyrics-lab.html` + `lyrics-lab.js`     | 独立测试台页面                                            |
| `apps/desktop/src/lyrics-lab-main.cjs` + `lyrics-lab-preload.cjs` | 测试台的独立主进程 / preload 入口                         |
| `scripts/verify-lyrics.mts`                                       | 自测脚本（真实网络 + 纯逻辑 + 解析器）                    |

**没有修改** `main.cjs` / `preload.cjs` / `renderer/index.html` / `style.css`：
测试台用自己的一套入口，避免与其他人正在改的文件冲突。

## 2. 接口来源（网易云，公开、无需登录）

```
搜索  GET https://music.163.com/api/search/get?s=<关键词>&type=1&limit=<n>
      -> { code:200, result:{ songs:[ { id, name, artists:[{name}], album:{name}, duration(ms) } ] } }

歌词  GET https://music.163.com/api/song/lyric?id=<songId>&lv=1&tv=1&kv=1&rv=1
      -> { code:200, lrc:{lyric}, tlyric:{lyric}, romalrc:{lyric} }
```

必须带 `User-Agent`（桌面 UA）与 `Referer: https://music.163.com/`，否则会拿到空壳响应。

实测样例：搜索 `Never Gonna Give You Up Rick Astley` → 首条 `id=18520488`
（Rick Astley，214s），`lrc` 2442 字符 + `tlyric` 1046 字符，解析后 48 行。

### 两个必须处理的响应形态

1. **`lrc.lyric` 为空串**：部分歌曲（版权受限 / 未抓取）返回 `code:200` 且
   `lrc:{lyric:''}`，既不设 `nolyric` 也不设 `uncollected`。
   这种情况**不当错误**，而是标记成「无歌词」，让上层继续试下一个候选
   （`NeteaseRawLyrics.isInstrumental`）。
2. **搜索召回与关键词强相关**：只搜标题的召回明显好于「标题 + 歌手」，
   网易云对「Rick Astley Tribute Band」这类同名条目的排序也会变。
   所以取词阶段是「按置信度从高到低逐个尝试」，而不是只信第一条。

## 3. 匹配算法（`lyricMatcher.ts`）

输入：本地歌曲元信息（标题 / 歌手 / 时长） + 歌词源候选。输出：**排序好的候选 + 置信度**。

### 归一化

- 全角转半角（含全角空格）
- 去括号内容（支持中英文括号与嵌套，如 `歌名 (Live (2020))`）
- 从**第一个版本说明词**处截断：`feat. / ft. / remaster / official / live / cover /
acoustic / instrumental / 伴奏 / 纯音乐 / mv / hd / lyrics / 字幕 …`
- 装饰性连接符统一成空格，其余标点丢弃，最后统一小写
- 另外还会剥掉「UP 主名 - 歌名」这种 B 站常见前缀

> ⚠️ 这里踩过两个正则坑，都在代码注释里留了记号：
> `[-_~～…]` 里的 `~～` 会被当成 `0x7E-0xFF5E` 区间把 `a-z` 全吃掉；
> `/[^\p{Script=Han}…a-z0-9\s]/gi` 在 Node 26 上会把假名整段吃掉。
> 现在用显式码点区间 + `A-Za-z`，行为可预期。

### 打分

| 维度       | 权重 | 说明                                                     |
| ---------- | ---- | -------------------------------------------------------- | --- | ------------- | --- | --------------------- |
| 标题相似度 | 0.55 | Dice 二元组系数（对中英混排短标题比编辑距离更稳）        |
| 歌手匹配   | 0.30 | 完全相同 1.0 / 互相包含 0.85 / 词集合有交集 0.7 / 否则 0 |
| 时长接近度 | 0.15 | `                                                        | Δ   | <=3s` 满分，` | Δ   | >=20s` 归零，中间线性 |

- 任一侧**缺时长**时，该项不参与打分，权重按比例分给标题与歌手
  （返回 0 会冤枉「候选没给时长」）。
- 加权和之上还有一层**惩罚系数**：标题 <0.35 乘 0.5、歌手为 0 乘 0.7、
  时长为 0 乘 0.7。没有它的话，「同名、同歌手、时长差 5 分钟」的候选
  也能拿到 0.85 —— 这是最常见的误匹配来源。
- 阈值：`AUTO_MATCH_THRESHOLD = 0.75`（可直接用），`MIN_USABLE_SCORE = 0.45`
  （低于此视为不可用，走人工搜索）。

## 4. 歌词面板（`lyrics-panel.js`）

刻意做成「**接收数据的纯 UI 模块**」，不碰 IPC / 音频 —— 因为 `preload.cjs`
正在被别人改，而且这样面板可以被任意宿主驱动（也不需要在渲染进程跑计时器）。

```js
const panel = window.createLyricsPanel(container)
panel.setLyrics([{ startTime /* ms */, content, translation }])
panel.setPosition(seconds) // 由外部（音频 progress 事件）驱动
panel.setActiveIndex(3)
panel.setOffset(-0.5) // 单位秒
panel.getState() // { lineCount, activeIndex, offset, activeText, ... }
```

挂载点：

- `window.createLyricsPanel` / `window.__lyricsPanel`（页面里有 `#lyrics-panel` 时自动创建）
- `window.__lyricsPanelUtils`（`findActiveIndex` / `formatTime`，便于脚本复算）

细节：

- **偏移语义**：`effective = position + offset`。`+0.5s` = 歌词提前 0.5 秒。
- 上下留白按滚动区实测像素写成 `height`（不能用百分比：滚动区是 flex 项，
  百分比高度不生效，会退回 `min-height`，高亮行永远贴不到中间）。
  面板尺寸变化时由 `ResizeObserver` 重算。
- 当前行判定用二分查找；返回 `-1` 表示「还没到第一行」（前奏）。
- 每行都带 `data-testid`：`lyric-line` / `lyric-text` / `lyric-translation`；
  头部控件：`lyrics-offset-minus` / `lyrics-offset-plus` / `lyrics-offset-reset`。
- 点击某行会派发 `lyricseek` 事件（`detail = { index, startTime }`），
  由宿主决定要不要 seek —— 面板自己不放音频。

## 5. 怎么单独跑

### 纯逻辑 / 真实网络自测

```bash
pnpm exec tsx scripts/verify-lyrics.mts            # 全部（含真实网络）
pnpm exec tsx scripts/verify-lyrics.mts --offline  # 跳过网络，只跑纯逻辑与解析器
```

脚本内注册了 Node 端口（原生 `fetch` 当 `HttpPort`、内存 Map 当 KV），
因此不需要 Electron 也能验证 core 的歌词链路。失败会 `process.exit(1)`。

> 解析器部分刻意**不**从 `packages/splash/src/index.ts`（barrel）导入：
> 该包没有 `"type": "module"`，Node 会把 `export * from './parser/merge'`
> 当 CJS 再导出，ESM 侧的命名导入会直接报错。按子路径精确导入即可。

### 歌词面板测试台（Electron）

```bash
apps/desktop/node_modules/electron/dist/electron.exe apps/desktop/src/lyrics-lab-main.cjs
```

页面：`lyrics-lab.html`。左侧是面板本体，右侧可以拖播放位置、调偏移、
输入关键词走真实网络取词（经主进程 → core 端口）。

环境变量：

| 变量                                   | 作用                                     |
| -------------------------------------- | ---------------------------------------- |
| `BBPLAYER_LYRICS_LAB_AUTOSHOT=1`       | 加载完自动截一张 `lab-auto.png`          |
| `BBPLAYER_LYRICS_LAB_SCRIPT=<js 文件>` | 加载完执行该文件（驱动面板 / 断言）      |
| `BBPLAYER_LYRICS_LAB_EXIT=1`           | 跑完自动退出（脚本化用；不加就常驻窗口） |

截图落在 `apps/desktop/probe-output/lyrics-lab/`。

## 6. 已知限制

- **⚠️ 主界面集成有一个未解决的问题**（2026-?? 记录，尚未定位）：
  歌词面板已接入 `renderer/index.html` 与 `renderer.js`，但**行元素不会渲染进 DOM**。
  实测现象（`scripts/verify-desktop-ui.mjs` 的 [ui] 9 段）：
  - `lyricsPanel().setLyrics(48 行)` 之后 `getState().lineCount === 48`（状态正确）
  - 但容器内 `li` 数为 **0**、`lyrics-list` 的 `innerHTML` 为空、
    `lyrics-meta` 仍显示 `— / 0` —— 说明 `renderLines()` 没有真正跑完
  - 面板实例是同一个、`list` 元素 `isConnected === true`
  - `data-active` 属性被正确写入（`11`），所以 `applyActive()` 跑到了

  该面板在独立页面 `lyrics-lab.html` 里 30/30 断言通过，所以问题出在
  **主界面集成这一层**，而不是面板本身。验证脚本已把这条记为警告而非通过，
  不用「状态正确」掩盖「DOM 未渲染」。

- **只接了网易云一个源**。`LyricsCandidate` 的 `source` 字段已经预留
  （`netease` / `qqmusic` / `kugou`），但没有实现其它源。
- **没有缓存**。每次取词都会重新请求；`LyricFileData`（core 里已有）
  是将来落库缓存的形状，本轮未接。
- **匹配靠启发式**。同名翻唱 / 伴奏 / 现场版仍可能选错，所以低于 0.75 的
  候选不会被自动采用（留给未来的手动搜索 UI）。
  实测例子：B 站视频标题「【4K修复】Rick Astley - Never Gonna Give You Up」
  与网易云曲名只匹配到 **0.36**，会被正确拒绝 —— 这是设计意图，
  但也意味着**从搜索直接播放时经常匹配不到歌词**，需要手动搜索兜底。
- **偏移量不持久化**（`getState().offset` 只在内存里）。
- 正则中的版本词截断对 `Song Live in Tokyo` 这类标题会截成 `Song`；
  标题需要人工确认时可走手动搜索。
