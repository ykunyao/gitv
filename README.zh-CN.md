# gitv

**把 `.git` 摊开在阳光下——每个字节、每个对象、实时。**

[English](README.md) | 中文说明

gitv 是一个拒绝把 `.git` 当黑盒的 git 仓库可视化器。它直接读取磁盘上的真实文件——loose 对象、packfile、index、refs——用**自己手写的解析器逐字节**拆开（不依赖 libgit2，也不借用 git 命令读对象数据），把整个对象数据库排进一个明亮、可拖拽的场景里，并且持续监听仓库：当你 commit、开分支、暂存、改写历史，场景会用动画把变化演出来。

<p align="center">
  <img src="docs/live.gif" alt="gitv 实时响应 commit、暂存与合并" width="880">
</p>

<p align="center">
  <img src="docs/overview.png" alt="gitv 总览——提交图、变更流、对象区" width="880">
</p>

## 你会看到什么

- **HISTORY** — 提交图：真实的 lane 路由、branch / tag / HEAD 徽章、merge 贝塞尔曲线、相对时间、历史截断处的虚线桩。悬停任意提交会点亮它的血缘边；拖动提交，边跟着走。
- **CHANGES** — `worktree → index → HEAD` 三列流转，与 `git status` 所见完全一致。编辑文件、`git add`、commit 时，chip 会在列与列之间移动。点击 chip 查看两个状态之间的内容 diff。
- **OBJECTS ON DISK** — 数据库里的每个对象，按类型分组、按内容定大小。loose 对象是白色实线卡片，已进 pack 的对象带虚线边框和深色底。文本 blob 直接预览前几行，图片渲染缩略图，大文件与二进制被织成字节挂毯（每字节一格，按值上色）。
- **PACKS ON DISK** — 把 packfile 按它在磁盘上的真实样子画出来：每个对象一个色块，位置是真实字节偏移、宽度是压缩后大小、颜色按类型，delta 与其 base 之间用弧线相连。悬停任意色块，它的整个 delta 家族点亮、其余褪色；点击进入对象详情。标题行读出大小、类型统计、delta 数量和压缩比。
- **Inspector** — 点击任意对象，自上而下读完整个解析故事：字节在哪里（loose 路径或 pack+offset）→ zlib 流 → 解压后的 `type size\0` 头部（高亮）→ 解析出的字段 → 完整性校验（重新哈希字节，复现对象名）。悬停某个字段，高亮它来源的精确字节；delta 对象会展示完整 delta 链——每一跳的 sha、类型和大小，一路到底层 base。

<p align="center">
  <img src="docs/inspector.png" alt="对象检查器：从原始字节到解析结果" width="700">
</p>

<p align="center">
  <img src="docs/field.png" alt="对象区：commits、tags、trees、blobs" width="700">
</p>

<p align="center">
  <img src="docs/diff.png" alt="worktree 与 index 的 diff" width="700">
</p>

<p align="center">
  <img src="docs/packmap.png" alt="packfile 字节地图：按偏移铺开的块与 delta 弧线" width="880">
</p>

## 实时

gitv 同时监听工作区**和** `.git`。commit、开分支、暂存、stash、amend、甚至 `git gc`——场景把新模型与旧模型做差，只对变化的部分做动画：新提交弹入、分支徽章沿图滑动、chip 跨列跳转、新对象在字段区闪现。中途重写整个 pack 的 `git gc` 也照常工作。HUD 里的连接圆点就是 SSE 心跳。

## 为问题而生

- **这个 commit 到底改了什么？** 每个提交都列出变更文件（手写 diff-tree，对第一父提交）；点击文件看行级 diff。
- **这个 commit 里有什么？** 检查它时，它不包含的对象全部变暗——它的 tree 和 blob 在字段区保持点亮。
- **那个文件 / 提交 / 对象在哪？** 按 `/`（或 Ctrl+K），输入路径、sha 前缀、分支名或提交主题，回车镜头就跳过去。
- **这个 blob 是以 delta 存的吗？** delta 对象会展示自己的链——每一跳的 sha、类型和大小——直到实底 base。

<p align="center">
  <img src="docs/scale.png" alt="1500 个提交的仓库" width="700">
</p>

## 运行

需要 [Bun](https://bun.sh) ≥ 1.1，PATH 里有 `git`。

```sh
bun run src/cli.ts serve path/to/repo          # 打开 http://localhost:8177
bun run src/cli.ts serve . --port 9000 --no-open
bun run src/cli.ts --help
```

在 gitv 自己的仓库里：

```sh
bun run demo      # 生成 demo-repo/ —— 什么都值得看一眼的仓库
bun test          # 解析器用 git 自己的输出验证
bun x tsc --noEmit
bun run scripts/record.ts   # 录制 docs/live.gif
bun run compile   # 单文件可执行 → dist/gitv(.exe)
```

`bun run compile` 会把前端打包进一个独立可执行文件（前端资源内嵌，自带 Bun 运行时）——拷到任何机器直接 `gitv serve <仓库>`，无需安装任何东西。

## 工作原理

`src/parse/` 里全部是从零手写的二进制解析器，在一个真实 fixture 仓库上用 git 自身的输出（`cat-file`、`verify-pack`、`ls-files`、`for-each-ref`）验证：

| 模块             | 解析内容                                                        |
| ---------------- | --------------------------------------------------------------- |
| `loose.ts`       | `objects/xx/yyy…` → zlib 解压 → `<type> <size>\0` 载荷          |
| `pack.ts`        | `.idx` v2 fanout/SHA/偏移表、pack 条目头、ofs/ref delta 链、copy/insert 指令 |
| `indexfile.ts`   | `.git/index`（DIRC）v2/v3/v4、扩展块、尾部校验和                |
| `refs.ts`        | `HEAD`、松散 refs、带 peeled 注记的 `packed-refs`               |
| `objects.ts`     | commit / tree / 附注 tag 载荷，带逐字段字节区间                 |
| `diff.ts`        | Myers 行级 diff，带前后缀裁剪                                   |

扫描器（`src/scan/repo.ts`)把这些字节组装成完整的 `RepoModel`——每个对象的类型、大小、存储位置（loose 文件或 pack+offset）——并对相邻两次模型做差生成事件。服务器（`src/server.ts`）提供模型、按需的解析阶段、原始字节、按提交的 diff 和 SSE 流；前端（`web/`）负责渲染与动画。

`git status`（porcelain v2）和超大仓库下的 `git rev-list` 是 gitv 仅有的两处借用 git CLI 的地方——用于变更分类和历史截断，从不用于对象数据。

## 说明与限制

- 完整支持 SHA-1 仓库；SHA-256 下 loose 对象、index、refs 可解析（32 字节条目的 pack 也能解析，但测试覆盖较少）。
- 不支持 pack index v1（2006 年前的旧格式）。
- 整个 pack 会映射进内存（每个 pack ≤ 160 MB；更大的 pack 改用定位读取）。
- Windows / macOS 支持递归 `fs.watch`；Linux 上对不支持的目录自动回退为轮询。

## 许可

MIT — 见 [LICENSE](LICENSE)。
