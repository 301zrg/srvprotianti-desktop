# 706 天梯助手

放在 YGOPro 或 KoishiPro 根目录的 Windows 桌面客户端。当前为开发中的首版，需求与验收范围见 [DESIGN.md](DESIGN.md)。

程序保留服务器网页的八个页面及中、日、英、韩四种语言。介绍页的 QQ 群号、IP、端口、合并地址和 TT 房间密码按钮可点击复制；常规联机行末的启动按钮只预填连接信息，天梯行末的启动按钮直接加入 TT。房间列表中，等待中的普通房间可点击加入，等待中的天梯房可直接进入 TT 匹配，已开局的房间可点击观战；密码房会要求当次输入密码。卡组与录像保存到游戏的 deck/replay 目录后直接打开。设置和旧裁定脚本更新位于设置页。

## 开发

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

上述命令构建无安装器的 exe，再把 exe 与 config.default.json 放入 release-portable。将这些文件复制到游戏根目录使用。可选 npm run build:installer 生成 NSIS 安装器；安装位置必须选择目标游戏根目录。

项目仅保存首次运行后的用户配置在 srvprotianti-desktop-data/config.user.json；覆盖默认值后不修改 config.default.json。默认游戏地址 121.4.34.71:7911，网页/API 地址独立为 http://121.4.34.71:7922。完整的“昵称$密码”登录串按用户输入保存在本地 JSON 中，请自行保管该文件。

“检查并更新”从 301zrg/specials 的 706 目录下载 Lua 到 expansions/script，并在同目录的应用数据中记录安装清单与备份。原版 YGOPro 还会从固定版本的官方 ygopro-scripts 取得纯净 utility.lua，将 706 的 special.lua 定义和调用嵌入扩展目录的 utility.lua；KoishiPro 不需要这份额外文件。程序不会修改游戏根目录的 script 或游戏配置。实际脚本优先级受目标游戏构建与“优先扩展脚本”设置影响。

## 页面来源与许可

web-source 中的八个 HTML 页面、site-shell.js、common.css 来自相邻的 srvprotianti 项目（本次调研时 HEAD 为 d23c284adf308747623d5d833f311cf2ff58a272）。桌面版对多个页面的按钮绑定作了修改；scripts/prepare-pages.mjs 在构建时提取页面脚本并改写介绍页按钮。同步上游页面时需核对这些改动与 [页面契约](../srvprotianti/plugins/ladder-web/WEB_PAGE_DEVELOPMENT_SPEC.md)。所有静态和动态按钮、表单操作都必须由外部脚本用 addEventListener 或元素事件属性绑定，不能在 HTML 或 innerHTML 字符串中使用 onclick、onchange 等内联事件属性；页面生成步骤会拒绝这种写法。同步后要在桌面构建中逐页检查搜索、筛选、翻页、刷新、下载、启动和语言切换。

原项目使用 GNU AGPL v3；本项目保留相同的 [许可证](LICENSE)。分发桌面程序时应同时提供对应源码。
