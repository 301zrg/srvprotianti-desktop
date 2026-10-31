# 706 天梯助手

放在 YGOPro 或 KoishiPro 根目录的 Windows 桌面客户端。独立签名页面更新自 v0.2.0 起提供，正式版本见 [Releases](https://github.com/301zrg/srvprotianti-desktop/releases)。需求与验收范围见 [DESIGN.md](DESIGN.md)。

维护者从 [当前实现架构](docs/ARCHITECTURE.md) 查看模块、调用流程、文件归属和构建发布关系；该文档区分已实现行为、设计目标与尚待游戏实测的项目。
每次改动按 [架构维护规范](docs/ARCHITECTURE.md#9-架构影响与图文同步) 判断影响；关系变化时同步对应图和说明，现有图文准确且已覆盖时保留。

服务端 Linux 部署、数据库/录像恢复与桌面连接地址迁移见 [统一运维指南](https://github.com/301zrg/srvprotianti/blob/b6ebeb19a2436ca5df442d41d1f8c749345be88c/ops/README.md)。

程序保留服务器网页的八个页面及中、日、英、韩四种语言。介绍页的 QQ 群号、IP、端口、合并地址和 TT 房间密码按钮可点击复制；常规联机行末的启动按钮只预填连接信息，天梯行末的启动按钮直接加入 TT。房间列表按公开 API 的 `roomtype` 显示实际类型；等待中的普通房间可点击加入，等待中的天梯房可直接进入 TT 匹配，已开局的房间可点击观战；密码房会要求当次输入密码。旧版 API 没有类型字段时，按严格房名格式识别已知随机房，其余按 `roommode` 显示。卡组与录像保存到游戏的 deck/replay 目录后直接打开。设置、1103 环境资源及旧裁定脚本更新位于设置页。

每页标题栏提供一键匹配、启动游戏、卡组编辑、查看录像四个快捷按钮。后两项分别以无文件名的 `-d`、`-r` 启动游戏，不要求填写昵称。设置页可手动检查正式版，并用系统浏览器下载 Windows ZIP，由玩家关闭游戏和助手再解压覆盖。

自 v0.2.1 起，助手版本检查读取 Release 附带的 `desktop-update.json`，不再请求 GitHub REST API。成功结果在本次助手进程内缓存 10 分钟；检查失败保留并明确标注上次结果和时间，始终提供官方下载页。该行为需要替换支持此能力的 exe，源码提交或排队本身不改变玩家安装。详细实施和发布验证见 [实施记录](docs/superpowers/plans/2026-10-26-desktop-update-manifest.md)。

首次使用独立页面更新需覆盖一次支持该功能的新版助手。此后兼容现有 Rust 命令/API 的页面改动可只发布页面包：启动使用已验证的本地页面，后台从独立 HTTPS 渠道检查和下载，下次启动应用。设置中显示页面版本与检查入口，原生“页面恢复”菜单及 `Ctrl+Shift+R` 可指定下次使用内置页面；普通 API 断网继续保留本地页面。新增本地能力或安全边界变化仍需更新 exe。设计、签名和发布边界见 [页面包约定](docs/PAGE_PACKAGE_UPDATE_PLAN.md)。

卡组详情的单卡投入率独立展开、分页及导出 XLSX/CSV（五个分区）。它以单独请求调用既有 `GET /api/ladder/deck-detail?view=card-usage`，兼容 v0.2.0 的原生 API 权限，可通过页面包更新。真实星号昵称按可见性决定链接，不再按名字字符判断是否匿名。

自 v0.2.2 起，使用率及卡组详情的单卡投入率支持“列表模式 / 图片模式”，共用紧凑网格和显示偏好，保留所有数值、分页、详情链接和导出。图片先读助手同级游戏目录的 `pics/<卡号>.jpg/.jpeg/.png/.webp`，逐一解码；失败后请求 momobako 的语言缩略图（中文 sc、英文 en、日文/韩文 jp），再失败尝试英文，最终保留密码和卡名。补图只用于展示，不写入玩家目录。新增本地读取能力需要更新 exe，页面包最低应用版本取构建源码中的 `package.json` 版本。

统计页默认 XLSX 另存为，也可选择 CSV：卡组月份矩阵十二指标、所选时期使用率/卡组详情，以及带密码验证后的玩家详细统计（月份/全部）。XLSX 分别有 12/6/4/4 张工作表，文件生成和压缩均在本地，不增加服务器导出任务；ExcelJS 4.4.0 随包提供，采用 [MIT 许可证](third-party/exceljs-LICENSE.txt)。排行默认当月；排行、战绩和设置页提供查询自己的入口。新版接口尚未部署时，玩家录像与私有统计显示临时占位，计分规则缺少生效参数时隐藏。

## 开发

先阅读 [分支与开发流程](docs/DEVELOPMENT_WORKFLOW.md)：唯一源码主线为 `main`，`page-updates` 专供更新索引；每项任务从最新主线创建短期分支，合并后同步常用本地目录并清理。合入主线与正式发布分别验收。

需要 Node.js、Rust stable 的 Windows MSVC 工具链、Microsoft C++ Build Tools、WebView2。Tauri 的 [Windows 前置条件](https://v2.tauri.app/start/prerequisites/) 有安装说明。

仓库包含 [Windows 构建工作流](.github/workflows/windows-desktop.yml)，可运行前端检查、Rust 测试并生成便携版构建产物。CI 已在 MSVC 环境中通过；实际 YGOPro/KoishiPro 目录中的联机、录像和脚本行为仍需验收，请勿把未做游戏实测的构建当作正式发行版。

~~~powershell
npm ci
npm run check
npm run tauri dev
~~~

开发模式默认将本工程目录当作游戏根目录；需要测试另一份受控游戏目录时，在当前终端设置 SRVPRO_DESKTOP_GAME_ROOT。正式版根据桌面程序自身位置寻找同级 ygopro.exe。

~~~powershell
npm run build
npm run package:portable
~~~

上述命令构建无安装器的 exe，再把 exe、config.default.json 与四语资源放入 release-portable。将其内容复制到游戏根目录使用。可选 npm run build:installer 生成 NSIS 安装器；安装位置必须选择目标游戏根目录，且使用环境资源时还须复制 release-portable 中的 resources 目录。

Windows CI 每次构建提供用于检查的 ZIP 和版本清单 artifact。维护者确认版本后推送与 package.json、tauri.conf.json、Cargo.toml 一致的 `v<版本>` 标签（或既有显式 `release/v<版本>` 分支），CI 才会创建草稿 GitHub Release，上传固定名称 `srvprotianti-desktop-windows-x64.zip` 与 `desktop-update.json`，核对来源标签、附件大小与 SHA-256 后公开并设置 latest。已有 Release 或不明确的发布结果停止待复核，不自动覆盖/重放。介绍页的“最新 Windows ZIP”链接保持可用；检查后的下载使用对应版本标签。解压 ZIP 时将内容直接放进 YGOPro／KoishiPro 根目录，保留 `srvprotianti-desktop-data` 文件夹。

项目仅保存首次运行后的用户配置在 srvprotianti-desktop-data/config.user.json；覆盖默认值后不修改 config.default.json。默认游戏地址 121.4.34.71:7911，网页/API 地址独立为 http://121.4.34.71:7922。完整的“昵称$密码”登录串按用户输入保存在本地 JSON 中，请自行保管该文件。

“检查并更新”从 301zrg/specials 的 706 目录下载 Lua 到 expansions/script，并在同目录的应用数据中记录安装清单与备份。原版 YGOPro 还会从固定版本的官方 ygopro-scripts 取得纯净 utility.lua，将 706 的 special.lua 定义和调用嵌入扩展目录的 utility.lua；KoishiPro 不需要这份额外文件。程序不会修改游戏根目录的 script 或游戏配置。实际脚本优先级受目标游戏构建与“优先扩展脚本”设置影响。

“安装／更新 1103 环境”与旧脚本更新互相独立。环境资源随 ZIP 提供，含四种语言的 5267 张卡池和 2011.3.1 禁卡表，安装本身无需联网。KoishiPro 从普通 `locales/zh-CN`、`ja-JP`、`en-US`、`ko-KR` 克隆出对应 `1103_` 目录，替换卡池、文字并添加当前天梯主机到 `servers.conf`；原版 YGOPro 则备份并替换根目录 `cards.cdb`。两者都会把禁卡表放进 `expansions/lflist.conf` 开头，设置 `system_user.conf` 的禁卡表选项，并暂存 `expansions` 根层的额外 CDB。安装和恢复前须退出游戏；设置页可一键恢复原文件。启动游戏时会同步当前界面语言及游戏服务器地址；若需要改动文件而游戏仍在运行，会先要求退出。程序不会为其他语言生成环境，亦不会自动更新游戏本体或禁卡表。

原文件备份与安装清单保存在 `srvprotianti-desktop-data/environment-backups/` 和 `environment-state.json`。恢复前会核对本程序托管的资源文件；若玩家后来手动修改，程序停止并保留修改与备份，避免误覆盖。游戏运行后可能自行改写 `system_user.conf`，因此恢复时只还原本程序管理的禁卡表选项及 KoishiPro 语言选项，保留游戏写入的昵称等其他设置。若曾因该文件变化而中断恢复，关闭游戏后使用新版桌面助手再点击“恢复原环境”即可继续。成功恢复后备份目录仍保留，确认游戏正常后可自行清理该目录。资源来源及校验数据见 `src-tauri/resources/environment/1103-201103-v1/manifest.json`。

## 页面来源与许可

公共业务源码归服务端 `plugins/ladder-web/web/`。维护者先运行 `node scripts/sync-web-source.mjs --website-root <受控web目录> --website-commit <已审核40位提交>`，同步八页和固定公共 assets 清单，记录源及生成文件 SHA。`web-source/source-manifest.json` 中来源提交必须对应实际功能，不能把底稿提交当作未提交功能的来源。构建不自动下载相邻仓库或远程 HTML。

这批生成快照的改动应回到官网源码或同步规则；原生动作归 `src/desktop-bridge.ts`，`self-query.js`、`page-updates.js` 和根目录设置页保留为平台适配。`prepare-pages.mjs` 先校验快照散列，再提取页面脚本和生成介绍页适配；人工改动快照会被拒绝。同步时需核对 [页面契约](https://github.com/301zrg/srvprotianti/blob/main/plugins/ladder-web/WEB_PAGE_DEVELOPMENT_SPEC.md)，并逐页检查搜索、筛选、翻页、刷新、下载、启动和语言切换。HTML 及生成字符串中禁止内联 onclick/onchange 等事件属性；使用 addEventListener 或元素事件属性绑定。

桌面构建还会按网页端胜率色阶生成静态 CSS；统计页用类名呈现红／中性／绿渐变，避免运行时内联颜色受 WebView 样式策略影响。

认证玩家详细统计中的普通卡组名称可进入卡组详情，保留月份／全部和语言参数；选择自身卡组后也提供同名链接。“其他”（4095）可选择查看统计并计入全部汇总，但名称不可点击。

原项目使用 GNU AGPL v3；本项目保留相同的 [许可证](LICENSE)。分发桌面程序时应同时提供对应源码。

本桌面助手及配套天梯网页均为开源、非盈利项目。若相关版权方提出要求，相关内容可能随时下架，敬请理解。
