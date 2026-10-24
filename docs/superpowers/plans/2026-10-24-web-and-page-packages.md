# 官网快捷入口与签名页面包实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 发布完整官网入口/设置功能，以及首次支持独立签名页面更新的桌面助手 v0.2.0。

**Architecture:** 官网复用已发布的 v1 intent/postMessage 契约；共享页面经桌面适配生成独立 dist。Rust 从本地已验证版本提供页面，后台下载 GitHub HTTPS 渠道的签名 ZIP，下一次启动切换，失败保留旧版和内置版。

**Tech Stack:** 原生 HTML/CSS/JS、Node 构建/签名、Tauri 2 / Rust、Ed25519、GitHub Releases / 独立渠道分支。

**Spec:** `docs/PAGE_PACKAGE_UPDATE_PLAN.md` 第 11 节，维护者已于本会话明确批准三个推荐选项、文案及检查通过后正式发布。

**Latest steering:** 2026-10-25 维护者明确要求将此前已批准功能准备为新队列并启动同一个 cmd，待服务器空闲后统一发布；此前暂缓指令已撤销。原模板批次已回滚并确认服务/文件/分类数据恢复，不重放或清空其回执。

## Global Constraints

- 业务 API 仍使用 HTTP；页面包仅从独立 HTTPS 渠道获取，公钥验证，不扩大本地/API权限。
- 官网顶部“一键匹配、开始游戏、卡组编辑、查看录像”，主要按钮为一键匹配；四语、手机两列。
- 密码不进入 URL/日志；持久化密码仅在用户勾选记住密码后发生。
- 不修改已发布 Cloudflare 接收端；正式站来源提交已读到 `7cd4321461104c6d40ece790ee89686acf8b4b4d`。
- 不修改原模板批次及其回执；新功能使用独立固定批次，由原 cmd 的单实例监控在完整空闲维护门禁通过后执行。
- 原有未提交改动保留；官网/助手产品代码在隔离工作区，原桌面仓同步本轮设计与进度文档。发布监控修复位于原服务端 `ops/`。正式基线为桌面 v0.1.4、官网服务器现用公开静态文件。

## Review Focus

- 页面来源变化后 Tauri IPC/CSP、根绝对路径、语言及本地动作可用。
- 旧界面认证输入、文件操作不中断；新版本仅下次启动启用。
- 错误签名、重复/非法路径、ZIP 越界/链接/炸弹、资源丢失、更新断网与启动失败可恢复。
- 已接受 sequence 不可网络降级；下载失败与 API 断网不得误判现有页面损坏。
- 官网固定来源/窗口/nonce/intent 校验，弹窗被拦、账号不完整与重复消息有可理解结果。

## Shared Package Contract

- JSON envelope: `schemaVersion:1, keyId:string, payload:base64, signature:base64`。
- 签名消息为 UTF-8 `srvprotianti-desktop-pages-v1` 加一个 NUL 字节，再拼接 payload 的原始 JSON 字节；Ed25519。
- payload: `application:'org.srvprotianti.desktop', channel:'stable', version:semver, sequence:positive integer, bridgeVersion:1, minAppVersion:'0.2.0', createdAt:ISO8601 UTC, expiresAt:ISO8601 UTC, archive:{url,size,sha256,unpackedSize}, files:[{path,size,sha256}], sourceCommits:{desktop,website}`。
- ZIP 仅含 dist 相对文件，不能含清单自身、链接、可执行文件、脚本/游戏资源或配置。渠道清单 URL 固定为 `https://raw.githubusercontent.com/301zrg/srvprotianti-desktop/page-updates/stable.json`；ZIP 固定仓库 `pages-v<version>` Release 的 `srvprotianti-desktop-pages.zip`。
- 私钥位于本机审计目录的 private 子目录并显式忽略；程序只提交 public key。首个页面 sequence=1，页面 version=1.0.0，迁移 exe=0.2.0。

## Task 1 — 官网入口和设置（独立测试循环）

- [x] 在 server 隔离工作区为账号缓存、intent/消息交接、设置与查询自己补充有区分度的测试，再实现；更新相关现有文档。
- [x] 用假账号和模拟接收页验证四语八页、320/390px 手机及横屏、排行/战绩月份分页不变、敏感值不出现在 URL。
- [x] 只修改官网 web 与专题文档/测试；桌面同步由集成任务负责。

## Task 2 — Rust 本地页面加载/签名更新器（独立测试循环）

- [x] 在 desktop 隔离工作区实现签名/兼容/sequence/ZIP 安装、启动选择和恢复；先写负例测试。
- [x] 使用 Shared Package Contract；与构建任务共享公钥文件 `src-tauri/page-update-public-key.json`，由协调者提供。
- [x] 原生稳定源提供内置/缓存两类资源，单次运行固定版本；页面 ready 命令与独立原生恢复入口配合，API 错误不触发回退。
- [x] 本地 debug 构建/测试并验证 WebView2 的真实 IPC/资源加载；修改范围限 src-tauri（含版本 0.2.0），保留既有 API/游戏行为。

## Task 3 — 共享源码与页面包生成（协调者）

- [x] 从官网已验证源生成桌面快照，保留平台适配、设置、本地启动/下载；为页面更新状态与 ready 交接补 UI。
- [x] 添加确定性页面包构建与签名工具；公钥/manifest格式与 Rust 一致；校验文件边界和密钥不入包。
- [x] 补齐正式来源门禁：声明的官网提交必须匹配 Git blob；包内来源必须与签名一致，CI 与本机直接发布都核对真实 Git 来源，draft 不可冒充正式来源。
- [x] 更新 JS 版本、工作流、文档；`npm run check` 64/64、Rust tests 49/49、Windows debug 构建通过。
- [x] 完成本机 Windows release 构建、独立离线 WebView 启动、便携候选与全部压缩条目散列核对（只生成本地制品）。

## Task 4 — 审核、发布与监控恢复（协调者）

- [x] 审核两侧 diff，验证同一个候选 exe 哈希不变时页面内容可更新，以及断网/坏签名/坏页面恢复；未把旧版 v0.1.4 描述为具备新加载器。
- [ ] 固定提交发布独立页面 Release 和签名渠道索引，不改变 exe latest；发布首次迁移版 v0.2.0 并下载核对。
- [ ] 官网静态发布逐文件核对线上旧 SHA、备份、资源在前 HTML 在后、HTTP 回读；不额外重启游戏。
- [x] 保留旧模板批次和完整回执；确认旧服务与分类数据恢复、本机监控停止，无协调器锁。
- [ ] 恢复现有 cmd 的单实例监控；核对新候选与回滚诊断后按最新授权启动。
- [x] 区分已实现、本地/CI验证、正式发布与未做的真实玩家/真机验收；准备就绪不能冒充正式发布成功。

正式发布及恢复监控项在实际执行和核验前保持未勾选，现已获准执行。当前正式批次诊断及新协调器的本地回归记录见工作区 `server-release-monitor/VERIFICATION.md`；服务器没有安装新的诊断工具。

## 本地验证与交付边界

- 官网：Node 8/8；Edge 四语八页与 320/390/844px、账号交接/自查/密码隔离通过。原有卡组导入和录像交接完整集成通过；关闭入口开关后介绍页示例下载的兼容问题已在真实回归中复现并修复。
- 桌面：最终 `npm run check` 64/64；原生桥浏览器 fixture 验证四语八页、房间/密码房/观战失效防护、授权卡组/录像下载及 Rust 身份隔离。真实 WebView、Rust 49/49、格式及 debug 构建证据归工作区 `.audit-tmp/web-desktop-pages-20261024/native-validation.json`。
- 同一 debug exe 的 SHA256 为 `8B8F12DD222416F03D79291A582783AEA8E98E084A3351BE1102F7EEFA6698E1`。本次运行维持 builtin，下次启动显示签名包 0.0.3 的可见测试文字；无 ready 的 0.0.2 被 45 秒看门狗隔离并自动恢复 0.0.1。页面 JS 禁用后，原生菜单仍能指定下次回内置版。
- 测试包只有本地演练用途，来源提交为全零占位，不进入正式发布。正式 publisher 会拒绝缺少或不匹配真实来源的制品。正式准备必须先固定官网提交，再同步快照、检查并固定桌面提交，最终签名包同时绑定这两个提交；不能拿底稿提交或 `websiteCommit=null` 冒充功能来源。
- 真实 HTTPS 正式渠道下载/安装、正式 GitHub CI、真实账号/游戏/玩家设备和生产发布仍需分别验收；正式渠道已按最新指令授权。`src-tauri/build-local.ps1` 仅复用本机已有便携工具链验证，已被 Git 忽略，不修改原 `.tooling`，不作为公共构建或正式发布的必要条件。
- 2026-10-25 本机 release 离线编译成功，发布版在全新独立 profile 和测试 API 下通过真实 WebView IPC/CSP 检查；测试窗口已关闭。本机便携候选 `srvprotianti-desktop-v0.2.0-local-candidate.zip` 为 6,494,432 字节、13 个文件，全部 ZIP 条目散列一致，不含用户配置/运行缓存/私钥。ZIP SHA256：`0D61CF0AB1936DDF36B86916A6D371BF258685665DD7A68B1A430C8B68FE9ED7`；release exe SHA256：`B1CA1DE020802A193C07D1133BABC3B974219B1AF357529764F90CED3533FE49`。这与前述 debug exe 是不同构建，不能混用其哈希作为页面切换证明；正式版本仍需从固定提交在 CI 重建并核对。
