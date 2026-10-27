# 桌面助手当前实现架构

更新日期：2026-10-25。应用候选版本 `0.2.0`，签名页面更新与共享页面适配已完成本地构建和 WebView 演练，尚未正式发布；当前生产下载不据此改变。原有游戏/脚本与环境模块职责保持现有实现。构建、WebView 验证与用户实际游戏验收分别记录。

## 1. 文档分工与架构结论

| 文档 | 用途 |
| --- | --- |
| [README](../README.md) | 用户入口、开发命令、便携版使用和发布说明 |
| [DESIGN](../DESIGN.md) | 产品需求、技术取舍、行为契约和验收标准；包含目标项，不能全部当作已完成 |
| 本文 | 当前模块、调用与数据流、文件所有权、构建发布，以及实现与设计的边界 |

当前架构由本地可信页面、Rust 文件/进程操作与服务端统计/认证组成。页面既可来自 exe 内置资源，也可来自独立 HTTPS 发布并通过本机公钥验证的缓存包；同一次运行固定版本和本地 origin。源码按配置、API、下载、启动、脚本更新、环境资源和页面更新组织，更新器分别拥有自己的清单与恢复流程。

页面同步使用显式源目录、固定清单和源/生成散列，平台差异集中在生成器与 Rust 桥接；仍须审核明确的来源提交和交互结果。

## 2. 三个项目中的位置

桌面助手负责展示数据、保存 YDK/YRP、维护玩家本地游戏资源和启动游戏。它不包含对战 Core，不计算天梯统计，也不直接连接服务器数据库。真正的对战连接由被启动的 YGOPro/KoishiPro 发起。

```mermaid
flowchart LR
    subgraph PC[玩家 Windows 电脑]
        Desktop["srvprotianti-desktop<br/>Tauri 桌面助手"]
        Game["YGOPro / KoishiPro<br/>游戏程序与本地 Core"]
        Files["本地 deck / replay<br/>配置、脚本与环境资源"]
        Desktop -->|启动参数| Game
        Desktop -->|校验、保存、备份与恢复| Files
        Game -->|读取游戏资源| Files
    end
    subgraph Server[服务器侧]
        API["srvprotianti<br/>天梯与公开 HTTP API"]
        TCP["srvprotianti<br/>原生游戏 TCP 接入"]
    end
    Desktop -->|HTTP 或 HTTPS 数据与下载| API
    Game -->|联机时使用 YGOPro 原生 TCP 协议| TCP
    Snapshot["srvprotianti 网页源码"] -.->|开发时手动同步快照| Desktop
    WebResources["srvprotiantiweb<br/>已处理的四语环境资源"] -.->|开发时复制资源| Desktop
    Github["GitHub<br/>706 Lua / 桌面 Release"] <-->|HTTPS 检查或下载| Desktop
```

`server.apiBaseUrl` 与 `server.gameHost/gamePort` 是独立配置。桌面页面查询 HTTP API；游戏进程在联机时根据启动参数连接 TCP 服务，卡组编辑和本地录像播放不要求建立这条连接。更改 API 地址不会自动更改游戏目标地址。`srvprotiantiweb` 在这里提供过资源来源，桌面程序运行时不依赖它的网页客户端、WebSocket 链路或浏览器对战运行时。

页面快照位于 `web-source/`；环境资源位于 `src-tauri/resources/environment/1103-201103-v1/`。相邻仓库不是桌面构建命令自动拉取的依赖。页面来源和资源来源分别见 [README](../README.md) 与 [DESIGN 第 14 节](../DESIGN.md#14-1103-环境资源与下载发布补充设计)。

## 3. 运行组件与信任边界

```mermaid
flowchart TB
    subgraph UI[内置或签名缓存的本地 WebView 页面]
        Pages["八个业务页 + settings.html"]
        Shell["site-shell.js<br/>导航、语言与公共呈现"]
        Bridge["desktop-bridge.ts<br/>fetch 适配、下载接管、房间预检"]
        Workbook["stats-export / stats-workbook<br/>ExcelJS 本地 XLSX/CSV"]
        Pages --> Workbook
        Workbook --> Bridge
        Pages --> Shell
        Pages --> Bridge
    end
    subgraph Native[Tauri Rust 本地层]
        Entry["lib.rs<br/>命令注册 / AppState / 互斥锁"]
        Settings[settings.rs]
        Api[api.rs]
        Download[downloads.rs]
        Reports[reports.rs]
        CardImages[card_images.rs：只读本地卡图]
        Game[game.rs]
        Script[scripts.rs]
        Env[environment.rs]
        Update[updater.rs]
        PageRuntime[pages_runtime.rs：固定本地源 / 后台检查]
        PageCache[pages_cache.rs：状态 / 安装 / 启动恢复]
        PagePackage[pages_package.rs：签名 / ZIP 边界]
        Entry --> Settings
        Entry --> Api
        Entry --> Download
        Entry --> Reports
        Entry --> CardImages
        Entry --> Game
        Entry --> Script
        Entry --> Env
        Entry --> Update
        Entry --> PageRuntime
        PageRuntime --> PageCache
        PageCache --> PagePackage
        Download --> Api
        Download --> Game
        Game -->|启动前同步环境| Env
        Env -->|进程和客户端识别| Script
    end
    Bridge -->|受限 invoke 命令| Entry
    Script -->|script-progress 事件| Bridge
    Api --> HTTP[服务端允许的 HTTP API]
    Script --> Git[GitHub 706 脚本与固定 utility.lua]
    Update --> Cache[进程内检查缓存与失败冷却]
    Cache --> Release[GitHub 正式版 desktop-update.json]
    PageRuntime --> PageChannel[独立 HTTPS 签名页面渠道]
    PageRuntime -->|srvpro-page-update 事件| Bridge
    Game --> Process[本地游戏进程]
    CardImages --> Pics[游戏根目录 pics：受限读取]
    Reports -->|用户原生对话框选取 XLSX/CSV 路径| Csv[统计表文件]
    Entry -->|open_external| Browser[系统浏览器]
```

| 源码入口 | 当前职责 |
| --- | --- |
| [src/desktop-bridge.ts](../src/desktop-bridge.ts) | 把原页面 `fetch` 转为 Rust API 调用，接管下载链接和 Blob，绑定桌面动作，保存语言，预检房间 |
| [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) | 确定游戏根目录、初始化设置和共享状态，注册受限本地命令，启动时尝试脚本事务恢复 |
| [settings.rs](../src-tauri/src/settings.rs) | 默认值与用户覆盖值递归合并、字段校验、临时文件替换、整体恢复默认 |
| [api.rs](../src-tauri/src/api.rs) | 方法和路由白名单、请求与响应限额、禁止跟随重定向，返回状态码、内容类型和 Base64 响应 |
| [downloads.rs](../src-tauri/src/downloads.rs) | 来源与内容校验、Windows 文件名处理、同名内容去重、保存并尝试打开 |
| [reports.rs](../src-tauri/src/reports.rs) | XLSX/CSV 另存为对话框，校验建议文件名与 8 MiB 内容上限，仅向用户选择且扩展名匹配的普通文件原子写入；XLSX 另查 ZIP 部件标记、512 部件/32 MiB 展开大小、拒绝宏部件，不自动打开文件 |
| [card_images.rs](../src-tauri/src/card_images.rs) | `read_card_images` 仅接受数字卡号，只读游戏根目录 `pics` 的 jpg/jpeg/png/webp；拒绝目录和文件重解析点，限制每图 2 MiB、每次合计 4 MiB，返回 Base64，不接受任意路径或写文件 |
| [game.rs](../src-tauri/src/game.rs) | 限定同目录 EXE、组合参数数组、调用环境检查，以游戏根目录为工作目录启动进程 |
| [scripts.rs](../src-tauri/src/scripts.rs) | 固定来源 Lua 检查下载、客户端识别、进程检查、冲突检查、清单与事务恢复 |
| [environment.rs](../src-tauri/src/environment.rs) | 离线 1103 资源校验、备份安装、启动时同步语言与服务器、恢复原环境 |
| [updater.rs](../src-tauri/src/updater.rs) | 校验静态版本清单、缓存结果/失败冷却、构造固定 tag 的下载地址；不替换正在运行的程序 |
| [instance.rs](../src-tauri/src/instance.rs) | Windows 上按规范化游戏目录生成互斥体名称，重复启动时激活已有窗口 |
| [webview.rs](../src-tauri/src/webview.rs) | 创建 WebView 前检查 WebView2，缺失时提供原生提示与安装页面入口 |
| [pages_package.rs](../src-tauri/src/pages_package.rs) | 验证签名原始字节、应用/兼容/时效、逐文件清单与 ZIP 内容边界 |
| [pages_cache.rs](../src-tauri/src/pages_cache.rs) | 页面专属缓存、递增 sequence、候选/上一版、启动确认与隔离恢复 |
| [pages_runtime.rs](../src-tauri/src/pages_runtime.rs) | 固定本地协议资源、后台受限 HTTPS 请求、页面状态与原生恢复入口 |

`get_settings`、`save_settings`、`reset_settings`、`set_language` 管理配置；`api_request` 管理数据请求；`launch_game`、`save_and_open`、`open_saved` 管理启动和下载；`script_state`、`update_scripts`、`restore_scripts` 管理脚本；`environment_state`、`install_environment`、`restore_environment` 管理资源；`check_desktop_update`、`open_external` 管理版本检查和外部链接。

卡组详情的单卡投入率使用独立懒加载请求 `GET /api/ladder/deck-detail?view=card-usage`，沿用 v0.2.0 已有的精确 GET 白名单。网页与助手共享单卡板块、数据和 XLSX/CSV 逻辑，按五分区导出；`sync-web-source.mjs` 与页面包来源清单都显式包含 `deck-card-usage.js`。本功能无需扩展 Rust 权限或重发 EXE。

使用率页的单卡“卡组分布”同理复用已放行的 `GET /api/ladder/usage/cards`，以 `view=deck-distribution` 区分；弹窗默认环形图，可切换完整列表，扇区或大号分类按钮只选中，明确的详情按钮再跳转。手机使用近全屏弹窗和固定详情栏，细小扇区通过分类列表选择；返回恢复同时处理重新加载与浏览器返回缓存。逻辑写在 `usage-stats.html` 内，样式在 `common.css`，不新增页面包资源文件，只需同步官网源码并发布页面包，无需改 Rust 白名单或重发 EXE。

页面更新只增加 `page_update_status`、`check_page_update`、`page_ready`、`recover_builtin_pages`。这些命令管理页面缓存，不接受任意更新地址、文件路径或新本地权限；页面业务仍沿用已有 Rust 能力和 API 白名单。

v0.2.2 候选为使用率及卡组详情单卡投入率的图片模式增加 `read_card_images`，由 `desktop-bridge.cardImages` 调用；共享 `card-images.js` 完成网格渲染、显示偏好、本地候选解码、语言图源与英文回退。原生文件读取在线程池中执行。外部图片以 HTTPS `img` 加载，本地内容使用已允许的 data URL，不扩大通用文件访问或任意网络 API 权限。页面包最低应用版本取构建源码的应用版本，新增能力本轮要求至少 v0.2.2；本地实现和发布验收仍分别记录。

本地页面只通过这些命令使用本地能力。Rust 不提供任意 shell 命令、任意文件路径写入或任意 API 路由入口。外部 HTTP/HTTPS 链接交给系统浏览器。权限配置见 [capabilities/default.json](../src-tauri/capabilities/default.json)，实际 CSP 见 [tauri.conf.json](../src-tauri/tauri.conf.json)。当前 CSP 的 `script-src` 和 `style-src` 含 `unsafe-inline`；构建器另行拒绝 HTML 和 HTML 字符串中的内联事件属性，因此不能把“构建时禁止内联事件”描述成“运行时 CSP 禁止全部内联脚本”。

`save_csv` / `save_xlsx` 只接收建议文件名和前端本地生成的数据，二进制 XLSX 经 Base64 传递；目标路径由 Windows 原生保存对话框确定，取消返回空，不自动启动表格软件。`stats-export.js` 复用网页导出逻辑，`stats-workbook.js` 使用随包的 ExcelJS 4.4.0，首次 XLSX 下载才加载，不调用服务器生成文件；CSV 仍使用原有编码。`self-query.js` 从桥接设置读取已保存昵称，排行只传昵称，战绩把密码分离后通过 POST 发送，跳转只带 `self=1`。

## 4. 关键调用与数据流

### 4.1 数据查询与文件打开

```mermaid
sequenceDiagram
    participant Page as 本地业务页面
    participant Bridge as desktop-bridge
    participant Rust as api.rs / downloads.rs
    participant API as srvprotianti API
    participant Disk as deck / replay
    participant Game as game.rs / 游戏
    Page->>Bridge: fetch 相对 API 路径
    Bridge->>Rust: api_request(method, route, body)
    Rust->>Rust: 读取配置、校验路由和限额
    Rust->>API: HTTP(S) 请求
    API-->>Rust: 状态码、类型、响应体
    Rust-->>Bridge: Base64 响应
    Bridge-->>Page: 标准 Response
    Page->>Bridge: 点击下载链接或生成的 YDK Blob
    Bridge->>Rust: save_and_open(route 或 deck bytes)
    opt 通过允许的下载路由取文件
        Rust->>API: GET 示例卡组 / 模板 / 录像
        API-->>Rust: 文件内容
    end
    Rust->>Rust: 类型与内容校验、选择不冲突的文件名
    Rust->>Disk: 原子替换单个新文件，或复用相同内容
    Rust->>Game: launch_saved，启动前检查环境
    Game-->>Rust: 启动结果
    Rust-->>Bridge: 保存结果与独立的 launchError
    Bridge-->>Page: 已打开，或已保存但启动失败并可重试
```

普通查询的 Rust 响应上限为 16 MiB，请求体上限为 4 KiB；下载路径的 YDK 上限为 1 MiB，YRP 上限为 64 MiB。直接通过 Blob 传入的仅允许是卡组，并限制编码大小与内容。示例卡组、模板和录像使用受限 GET 路由；页面中经过玩家接口认证取得的卡组内容以 Blob 交给保存层。是否有下载权限由服务器处理对应查询请求，桌面端不重新定义公开范围。

同名相同内容复用已有文件，同名不同内容增加编号，不覆盖玩家编辑的卡组。保存成功与游戏启动成功是两个结果；游戏启动失败时保留已保存文件，重试入口走 `open_saved`。

### 4.2 启动、房间加入与观战

```mermaid
flowchart LR
    Action[页面动作] --> Kind{动作类型}
    Kind -->|常规联机或 TT| Name[检查登录串]
    Kind -->|指定房间| Room[重新查询房号、原房名、状态]
    Room --> Password[必要时询问一次性房间密码并再次预检]
    Password --> Name
    Kind -->|编辑器或录像列表| Invoke[launch_game]
    Name --> Invoke
    Invoke --> Lock[file_lock 与脚本未完成事务检查]
    Lock --> Args[game.rs 构造参数数组]
    Args --> Env[environment.prepare_launch]
    Env --> Spawn[Command 启动同目录游戏 EXE]
    Spawn -->|联机动作| TCP[游戏自行连接原生 TCP 服务]
    Spawn -->|编辑或回放| Local[读取本地卡组或录像]
```

常规联机只预填昵称和地址；TT 使用 `-w TT -k -j`。指定房间的加入与观战使用原房名 `-w ... -j`，观战依赖目标房间已经开局。编辑器与录像列表分别使用无文件名 `-d`、`-r`，不要求昵称。打开已保存卡组时 `-d` 的文件名去掉 `.ydk`，录像 `-r` 保留 `.yrp`。

房间预检查发生在 TypeScript 适配层，不能消除预检查之后房间立即关闭的竞态。助手没有修改服务器进房协议；这一限制已在 DESIGN 中记录。完整登录串作为单个参数传给游戏，不由 shell 解释。

房间页优先使用服务端 `roomtype` 作为类型与等待房按钮动作依据，`randommode` 补充其他随机模式代号。旧版 API 缺少可识别的类型字段时，才严格匹配已知随机/AI 房名，其余按 `roommode` 回退。类型是 `ladder_match` 的等待房调用 TT 匹配；普通房即使名字看起来像天梯房，也按服务端类型调用原房名加入。实际逻辑见 [web-source/rooms.html](../web-source/rooms.html)，对应回归测试见 [scripts/rooms.test.mjs](../scripts/rooms.test.mjs)。

助手配置与设置输入框最多保存完整登录串的 80 个 UTF-16 单位，Rust 不截断合法输入。该本地保存上限不能当作游戏联机协议的可用昵称长度：当前 [设置页](../settings.html) 明确提醒完整“昵称$密码”联机时最多 19 个单位，超出可能被游戏截断而登录失败。这里按项目当前提示记录兼容限制，不把 20 单位缓冲区理解为 20 个可输入昵称字符，也不承诺任意游戏构建都能传递 80 单位。

## 5. 配置、文件所有权与恢复

正式版以桌面 EXE 的实际目录为游戏根目录。开发版默认使用源码工程目录，可通过 `SRVPRO_DESKTOP_GAME_ROOT` 指向受控测试目录。一份助手对应一个游戏目录。

```text
游戏根目录/
  ygopro.exe                         玩家安装的游戏程序
  srvprotianti-desktop.exe            本项目发布产物，内含页面
  deck/                              保存的 YDK 与玩家已有卡组
  replay/                            保存的 YRP 与玩家已有录像
  script/                            游戏原始基础脚本；脚本更新器不改
  expansions/
    script/                          本项目管理的 706 Lua，及其他已有脚本
    lflist.conf                      环境安装器备份后加入 1103 禁卡表
  cards.cdb                          原版 YGOPro 安装环境时替换并保留原备份
  system_user.conf                    只管理环境所需的少数配置键
  locales/1103_<locale>/              KoishiPro 安装环境时创建的四语目录
  srvprotianti-desktop-data/
    config.default.json              发布默认值；缺失时从 EXE 内置值生成
    config.user.json                 用户覆盖值，可能含完整登录串
    config.user.reset-<UUID>.json     整体恢复默认时保留的旧用户配置
    script-state.json                已安装脚本版本、散列与原始备份引用
    script-pending.json              未完成事务 ID；成功后移除
    backups/
      original/                      首次接管脚本前的内容
      transactions/<UUID>/           journal.json 与本次修改前备份
    environment-state.json           资源清单、散列、备份 ID 与阶段
    environment-backups/<UUID>/      环境改动前的文件
    resources/1103-201103-v1/         随便携包发布的离线环境资源
    page-packages/
      state.json                     最高 sequence、当前/候选/上一版与启动确认
      packages/<版本>/manifest.json  已验证的签名清单
      packages/<版本>/dist/          逐文件散列校验的只读页面资源
```

具体备份文件名以清单引用为准。DESIGN 中的 `staging/` 和 `logs/` 是目标示意；当前脚本下载在内存中准备数据，事务使用 `script-pending.json` 和 `backups/transactions/`，没有对应的常驻 staging/logs 目录实现。

```mermaid
flowchart LR
    Config[settings.rs] --> Defaults[默认值与用户覆盖 JSON]
    Downloads[downloads.rs] --> DeckReplay[deck 与 replay 新文件]
    Scripts[scripts.rs] --> Lua[expansions/script 托管 Lua]
    Scripts --> ScriptState[script-state 与 script-pending]
    Scripts --> ScriptBackup[backups 原内容与事务备份]
    Environment[environment.rs] --> GameResource[cards.cdb 或 1103 locales]
    Environment --> GameConfig[lflist.conf 与 system_user.conf 的指定键]
    Environment --> EnvState[environment-state 与 environment-backups]
    Bundle[便携发行包] --> Offline[离线 resources]
    Offline --> Environment
```

| 所有者 | 修改边界和冲突处理 |
| --- | --- |
| 配置模块 | 保存差异覆盖值，运行时不改写已有默认文件；损坏配置报错并保留。整体恢复默认先归档用户文件，不删除卡组或录像 |
| 下载模块 | 只保存到校验后的 `deck/`、`replay/`；拒绝目录逃逸和链接路径；同名不同内容另存 |
| 706 脚本更新器 | 只管理 `expansions/script` 中清单登记的文件；未管理文件保留，本地改动进入冲突处理；恢复的是上次更新，不是整个游戏目录 |
| 1103 环境安装器 | 安装离线四语资源、暂存 expansions 根层其他 CDB、维护禁卡表和指定配置键；普通 locales 是克隆来源，不整体覆盖 |
| 游戏程序 | 持有自身 EXE、Core 与基础资源；可能重写 `system_user.conf`，恢复环境时保留昵称等非托管字段 |

旧裁定脚本与环境资源是两套独立安装状态：前者在线取固定来源 Lua，后者校验随包的离线资源。两者都检查游戏进程。`environment.rs` 复用 `scripts.rs` 的进程检查和 KoishiPro 识别，因此它们在实现上并非完全无依赖。

### 5.1 脚本更新事务

更新器固定一次 GitHub commit，定位 706 子树，校验 Git blob SHA，并记录本地 SHA-256。较多文件变化时先尝试固定 commit 的 ZIP，失败后退回固定 commit 的 raw 文件。原版 YGOPro 另用固定版本的官方 `utility.lua` 与该次 `special.lua` 生成扩展脚本；KoishiPro 不生成这份额外文件。

```mermaid
flowchart TB
    Check[恢复既有未完成事务、检查游戏已退出] --> Fetch[固定 commit、下载与校验]
    Fetch --> Conflict{托管文件有冲突}
    Conflict -->|有| Choice[返回冲突，用户取消或允许备份覆盖]
    Choice -->|允许覆盖后重新执行| Check
    Conflict -->|无| Lock[取得 file_lock，复查游戏与文件散列]
    Lock --> Journal[保存原文件、事务 journal 与 pending ID]
    Journal --> Apply[逐文件替换或移除托管文件]
    Apply -->|成功| Commit[写 script-state，移除 pending]
    Apply -->|失败或下次启动发现 pending| Rollback[按事务反向恢复，先核对后续人工修改]
    Rollback -->|恢复失败| Block[保留 pending 与备份，阻止助手启动游戏]
```

应用和恢复持有 `file_lock`；下载阶段不一直持有该锁，应用前会重新检查游戏和文件是否变化。`script_lock` 防止同时进行多个脚本更新/恢复。`config_lock` 串行化设置写入。每个文件用同一文件系统临时文件替换，多文件安装依靠清单与恢复流程保持可恢复性，不是一次性原子事务。

### 5.2 环境资源状态

```mermaid
stateDiagram-v2
    [*] --> Absent
    Absent --> Installing: 校验离线资源并保存备份
    Installing --> Active: 全部写入成功
    Active --> Installing: 更新资源或启动前同步
    Active --> Restoring: 用户恢复原环境
    Installing --> Restoring: 失败后尝试回滚
    Restoring --> Absent: 恢复成功并删除状态文件
    Installing --> Recovery: 异常退出或回滚未完成
    Restoring --> Recovery: 冲突或恢复中断
    Recovery --> Restoring: 用户处理原因后再次恢复
```

`Recovery` 是对外 `needsRecovery` 的说明，磁盘状态实际保留 `installing` 或 `restoring` 阶段。脚本在助手启动时尝试自动恢复；环境资源的未完成状态则要求从设置页恢复，启动游戏前的 `prepare_launch` 会拒绝未完成状态。已安装且状态正常时，启动前同步所选语言与服务器；如果需要写文件而游戏仍运行，会拒绝继续。环境恢复成功后原备份目录仍保留。

## 6. 页面构建与发布链路

```mermaid
flowchart TB
    Website["受控官网源码 + 明确来源提交"] --> Sync["scripts/sync-web-source.mjs<br/>固定清单 / 平台适配 / 源与生成 SHA"]
    Sync --> WebSource["web-source 生成快照 + source-manifest.json"]
    WebSource --> Prepare["scripts/prepare-pages.mjs<br/>先核对快照 SHA"]
    Settings[根目录 settings.html] --> Prepare
    Prepare --> Public["public 页面与 assets/pages 脚本<br/>生成静态色阶 CSS，拒绝内联事件"]
    Bridge[src/desktop-bridge.ts] --> Esbuild[esbuild IIFE 打包]
    Esbuild --> Public
    Public --> Vite[Vite 构建 dist]
    RootIndex[index.html] --> Vite
    Vite --> Tauri[Tauri 与 Rust 编译]
    Vite --> Sign["本机页面包构建 / Ed25519 签名"]
    Sign --> Candidate["候选签名清单：绑定源码提交 A"]
    Candidate --> PageCI["desktop-pages.yml<br/>可信默认分支验签 / A 构建 / 精确重建"]
    PageCI --> PageRelease["不可变 pages-v Release<br/>make_latest=false"]
    PageRelease --> Index["page-updates 稳定索引"]
    Rust[src-tauri Rust 模块] --> Tauri
    Tauri --> Exe[srvprotianti-desktop.exe]
    Exe --> Portable[scripts/package-portable.mjs]
    Default[发布默认配置] --> Portable
    Resources[离线四语资源] --> Portable
    Portable --> Zip[便携 ZIP]
    Zip --> Artifact[Windows CI artifact]
    Artifact --> Tag{v 标签或 release/v 分支与三处版本一致}
    Tag -->|通过| Draft[草稿 Release 上传 ZIP 与版本清单]
    Draft --> DraftId[已认证列表定位唯一草稿 ID]
    DraftId --> Verify[按 ID 核对来源提交、附件大小及 SHA-256]
    Verify --> Release[公开 Release 并确认 latest]
```

官网八页和公共资产先按显式清单同步，生成快照保存来源和散列。构建器核对快照后，从页面提取 `<script>`、插入桌面桥接脚本并生成介绍页适配。业务改动回官网源码，适配改动回同步器/桥接，桌面设置和手写适配脚本各归原文件。`public/`、`dist/`、`release-portable/` 属于生成产物。Tauri 仍直接打开 `rooms.html`，根入口跳转到房间页。

命令定义见 [package.json](../package.json)：`npm run check` 包括 TypeScript、页面构建、色阶/房间/统计以及同步和页面包回归；Rust 测试独立运行。Windows [EXE 工作流](../.github/workflows/windows-desktop.yml) 使用 Node 22，执行前端检查、Rust 格式/测试、编译与便携打包。普通分支只上传 artifact，版本标签或显式 `release/v<版本>` 分支通过三处版本核对后发布 EXE。

[页面工作流](../.github/workflows/desktop-pages.yml) 接受 `page-candidates/**` 的公开签名清单，先用默认分支的可信校验器/公钥确认来源提交 A，再检出 A、构建并按签名清单精确重建 ZIP。私钥只在本机使用，不进入 CI；页面资源先发布成功，再更新单独的稳定索引，不占用 EXE 的 latest。未固定来源提交的本地快照可以验证，但不能冒充对应正式来源发布。

便携包的环境资源实际路径为 `release-portable/srvprotianti-desktop-data/resources/1103-201103-v1/`。可选 NSIS 构建没有通过 Tauri bundle 配置携带这批环境文件；若使用安装器，须另外保持这个相对游戏根目录的数据目录结构。

助手更新由 [原生检查器](../src-tauri/src/updater.rs)、[设置页适配](../src/desktop-updates.js) 和 [发布脚本](../scripts/desktop-release.mjs) 协作。检查器以专用 HTTPS 客户端读取最新 Release 的静态 `desktop-update.json`，不依赖 REST API 匿名额度，成功结果缓存 600 秒，失败冷却并保留带原时间的旧结果。共享的附件跳转域名约束归 `release_http.rs`，业务 API 客户端仍禁止跳转。检查后的 ZIP 链接固定已验证版本，页面始终有官方下载页入口；仍由系统浏览器下载、玩家手动覆盖。清单 SHA-256 用于发布附件核对，不宣称助手已校验浏览器下载的 ZIP。完整契约见 [DESIGN](../DESIGN.md#121-助手版本清单2026-10-26-v021)。v0.2.1 及页面包 1.0.2 已正式发布并核验，源码/标签仍固定 `22f1128`；草稿发布查询的修复只影响后续发布工具，不改写这个已发布提交或制品。

页面加载保持原 `tauri` 本地 origin 和 IPC/CSP 边界；每次启动固定使用通过签名与逐文件校验的缓存目录或内置资源。`page-packages/state.json` 保存已接受的最高 sequence 和候选/当前/上一版；候选启动先写 booting，再由页面 ready 确认，异常退出或 45 秒无确认则隔离并回退。网络下载发生在页面 ready 之后，更新成功也只在下次启动切换。原生菜单提供独立恢复入口；普通业务 API 错误不会触发回退。完整信任和缓存边界见 [页面包约定](PAGE_PACKAGE_UPDATE_PLAN.md)。

## 7. 当前实现与设计目标的区别

| 项目 | 当前状态 |
| --- | --- |
| 设计中的目录示意 | 当前以本节之前列出的实际清单为准；未实现常驻 `staging/`、`logs/` 目录 |
| 设置恢复 | 已实现整体恢复默认并归档原用户配置；未提供独立的单字段恢复按钮 |
| 设置 schema 迁移 | 当前只接受 `schemaVersion = 1`，其他版本报错；DESIGN 中未来版本迁移流程不是已实现能力 |
| 页面来源记录 | 同步器记录固定源清单、来源提交和源/生成 SHA；未固定实际功能提交的本地快照不能作为正式来源发布 |
| 独立页面更新 | v0.2.0 与页面 1.0.0/sequence 1 已于 2026-10-25 正式发布；兼容原生能力的页面可独立更新 |
| 脚本、环境恢复 | 源码有散列、事务及冲突处理和单元测试；这些不能替代真实游戏下的恢复验收 |
| Windows 与游戏行为 | README/DESIGN 记录 CI 曾通过，同时仍要求两种游戏联机、卡组、录像、旧裁定脚本，以及缺失 WebView2 场景实测 |

这些差异应作为维护和验收记录保留，不能据此宣称设计中的所有目标都已交付。构建、合成浏览器/原生验收和正式发布分别留证，不能相互替代。

## 8. 维护时从哪里修改

| 变更类型 | 主要入口 | 必须一起核对的边界 |
| --- | --- | --- |
| 页面内容、统计呈现、翻页筛选 | 官网源码，经 `sync-web-source.mjs` 同步 | 页面契约、源/生成 SHA、桌面事件绑定、四语言 |
| 桌面平台适配、设置 | 同步器、`desktop-bridge.ts`、根设置页及手写适配脚本 | 不直接修改已登记快照；保留本地动作、账号与下载语义 |
| 页面签名/缓存/加载 | `page-package.mjs`、`pages_package/cache/runtime.rs` | 固定来源、信任根、兼容、sequence、下次启动及独立恢复 |
| API 传输或新增查询 | `release_http.rs` 与 `desktop-bridge.ts` | 路由白名单、方法、权限语义、响应限额 |
| 新增本地动作 | `lib.rs`、对应 Rust 模块与桥接类型 | 参数校验、游戏目录限制、互斥与错误显示 |
| 游戏启动方式 | `game.rs` | 参数次序、单个登录串参数、真实游戏兼容、环境同步 |
| 706 脚本行为 | `scripts.rs` | 固定来源与一致 commit、两种客户端、冲突、事务恢复 |
| 四语环境资源 | `environment.rs` 与资源 manifest | 文件散列、卡池一致性、原文件备份、配置按键恢复 |
| 构建与发行 | `package.json`、Tauri 配置、打包脚本和 CI | 三处版本一致、ZIP 相对目录、用户数据保留 |

涉及本地文件的功能用受控游戏副本验证，并按 DESIGN 的验收表记录游戏构建和结果。纯文档更新检查链接和 Markdown 即可。当前架构说明覆盖本项目运行和维护关系；全新服务器迁移、数据库和服务端录像恢复属于独立的运维评估，本文不作已验证承诺。

## 9. 架构影响与图文同步

每次改动判断是否改变模块职责/依赖、WebView/Rust/游戏进程或信任边界、命令与调用顺序、
文件/配置所有权、安装事务与恢复、资源来源或构建/发布链路。任一关系变化时，
在同一交付中更新本文对应 Mermaid 图、源码入口和说明，以及实际变化的 DESIGN 行为契约。
涉及服务端 API 或页面/资源快照时一起核对来源和消费者，区分已实现与尚待游戏实测。

文案、样式、示例内容及保持上述关系的局部修复，图仍准确时保留；README、DESIGN 或本文
已合理覆盖行为时无需重复修改。交付说明影响判断和更新/保留的图；文档检查链接、图语法与 diff，
功能验证按 DESIGN 的受影响验收项选择，不以文档更新代替 Windows 或真实游戏验收。
