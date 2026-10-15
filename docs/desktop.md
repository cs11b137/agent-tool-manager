# P6 · 桌面应用

`packages/desktop` 使用 Tauri 2，复用 UI、HTTP server 和 core。桌面程序携带 Node、服务端 bundle 和前端静态资源，运行时不需要终端、开发服务器、pnpm 或另装 Node。Git 操作仍需本机 Git；MCP 自身需要的程序和凭据沿用用户环境。

## 使用

1. macOS 打开 DMG，将 **Agent Tool Manager.app** 拖入 Applications，双击启动。首次使用与 Web 版一致：创建共享仓库 → 新建工具 → 添加项目 → 关联工具。
2. 关闭窗口后继续驻留托盘；点击托盘的「打开窗口 / Open window」或 Dock 图标重新打开。系统不支持托盘时，关闭窗口会退出。
3. 「登录时启动 / Launch at login」默认关闭，可从菜单启用；登录启动时仅驻留托盘，不弹出窗口。
4. 服务异常时显示错误页，从应用菜单或托盘选择「重启服务 / Restart service」。选择「退出 / Quit」或 Cmd/Ctrl+Q 会同时关闭应用和后台服务。

重复打开应用会聚焦现有窗口，不再启动第二个服务。桌面版与 `atm ui` 使用同一份真实配置和仓库；桌面版不会自动导入工具或项目。

## 开发和构建

依赖：Node 22+ 官方发行版、pnpm、Rust 1.90+、对应系统的 [Tauri 构建依赖](https://v2.tauri.app/start/prerequisites/)。macOS 最低版本为 14；使用当前机器架构构建。禁止跨架构打包本机 Node，其他系统和架构应在对应机器上构建。

```sh
pnpm install
pnpm desktop:dev
pnpm desktop:build
```

`desktop:dev` 自动构建真实 UI 和服务资源，启动原生窗口；修改 UI 后重新运行或先构建资源再从菜单重启服务。需要 UI 热更新时仍用 `pnpm --filter @atm/ui dev`。

`desktop:build` 产物位于 `packages/desktop/src-tauri/target/release/bundle/`。macOS 为 `.app` / `.dmg`，Windows 和 Linux 由 Tauri 的当前平台打包器生成安装包。构建脚本复制当前构建环境的 Node，记录版本、平台、架构、SHA-256，并包含 Node 许可证。首次构建需联网获取依赖和运行时许可证。

没有配置发布者签名时，产物用于本机验证。向外部分发 macOS 应用前需设置 Apple Developer 签名和公证凭据；Windows 分发按组织要求配置代码签名。这些账号凭据不放入仓库。参考 [Tauri macOS 签名](https://v2.tauri.app/distribute/sign/macos/)。

## 生命周期和安全

Rust 启动内置 Node，通过私有 stdout 管道接收随机端口和新 token；不将 token 写入磁盘或进程参数。前端继续使用既有 Bearer token、Host/Origin 校验和 SSE。只有该进程返回的 `127.0.0.1` 地址可加载到主窗口，未向页面授予 Tauri 原生 API 权限。

应用退出时关闭 stdin，Node 取消任务、关闭 SSE 和目录监听后退出；超时则由父进程终止。父进程意外崩溃时，stdin EOF 同样触发清理。服务意外退出会切回错误页，不会静默留下空白窗口。

`~/.config/atm/desktop.json` 仅记录上次监听端口，使语言和主题偏好能跨启动保留；不保存 token。端口被占用会自动改用空闲端口，此时界面偏好使用新源的默认值。全局业务配置仍为 `~/.config/atm/config.json`。

macOS/Linux 会有上限为 3 秒的登录 shell PATH 读取，补齐 Finder 等图形启动环境的工具路径；失败则使用系统 PATH。内置 Node 路径始终加入 PATH。服务错误日志为应用日志目录下的 `service.log`，每次启动覆盖；错误页显示实际位置。

实现参考：[Tauri 资源打包](https://v2.tauri.app/develop/resources/)、[系统托盘](https://v2.tauri.app/learn/system-tray/)、[单实例](https://v2.tauri.app/plugin/single-instance/)、[登录启动](https://v2.tauri.app/plugin/autostart/)。

## 验证

```sh
pnpm --filter @atm/desktop build
pnpm --filter @atm/desktop test
pnpm --filter @atm/desktop check:rust
pnpm typecheck
```

Node 集成测试使用临时 HOME 和内置 Node，覆盖空白首次启动、真实静态页面、鉴权、共享 Git 仓库、创建 Skill、项目关联、父进程管道关闭、SIGTERM、端口复用与冲突回退。Rust 测试覆盖启动地址校验和导航边界。

发布前在目标系统检查：双击启动、窗口关闭与托盘恢复、重复启动、服务故障后重启、退出无遗留进程、登录启动开关。Windows/Linux 的原生窗口和系统集成需要在各自平台验收，不能用 macOS 构建结果替代。

### 本次验收记录（2026-10-15）

1. macOS Apple Silicon release 构建成功，生成 `.app` 和约 40 MB 的 `.dmg`；从应用包打开，主窗口显示真实工作区和已连接的 SSE。
2. 全工作区 171 项测试、2 项 Rust 测试、类型检查和 Rust Clippy（警告视为错误）通过；额外直接使用 `.app` 内的运行资源重跑 3 项集成测试通过。
3. 关闭窗口后桌面进程与服务保持运行；再次启动可恢复现有窗口，未产生第二个后台服务。菜单重启成功回收旧服务并启动新服务。
4. 主动停止本次测试的后台进程后，窗口显示故障提示；菜单重启恢复正常。Cmd+Q 后桌面进程退出，原端口不再监听。
5. 登录启动保持默认关闭，未修改用户系统启动项；实际登录启动、Windows/Linux 原生体验与发布签名公证不在本次机器验收结果中。
