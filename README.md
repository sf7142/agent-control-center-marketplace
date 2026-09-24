# Agent Control Center 插件市场

CodeBuddy Code 插件：Agent 生命周期弹窗提醒 + 权限决策 + 状态行。

## 功能

- **权限决策弹窗**：Agent 请求执行需要授权的操作时，弹 WPF 三键弹窗（拒绝 / 同意并记住 / 同意），结果经 `hookSpecificOutput` 回传 CodeBuddy。
  - 「同意并记住」写入 `<项目>/.codebuddy/settings.local.json` 的精确权限规则（CodeBuddy 原生机制）。
- **任务完成/失败提醒**：`Stop` / `StopFailure` 触发系统级 GUI + 声音。
- **AskUserQuestion 拦截**：Agent 用 `AskUserQuestion` 提问时，弹富交互问答窗（单选/多选/自定义输入），答案经 `updatedInput` 回传。
- **状态行**：输入框下方显示 模型名 + 上下文使用率渐变进度条 + git 分支 + 工作目录 + 时间。
- 支持 `--preview` 模式预览所有弹窗，`notify_config.json` 配置 HTTP 通知与声音。

## 环境要求

- **Windows 10/11**（弹窗/状态行依赖 PowerShell 5.1 + WPF）
- Node.js ≥ 22.18

> 本插件目前仅支持 Windows。macOS / Linux 下弹窗与状态行不会工作。

## 安装（多种分发方式）

以下四种方式，成员任选其一即可。安装后重启 CodeBuddy Code，或会话里运行 `/reload-plugins` 生效。

### 方式一：GitHub 仓库市场（线上，推荐）

```bash
/plugin marketplace add <你的用户名>/agent-control-center-marketplace
/plugin install agent-control-center-hook@agent-control-center
```

### 方式二：其他 Git 托管（GitLab / 内网 Git 等）

```bash
/plugin marketplace add https://gitlab.com/你的团队/agent-control-center-marketplace.git
/plugin install agent-control-center-hook@agent-control-center
```

### 方式三：本地目录（开发 / 测试）

```bash
/plugin marketplace add ./agent-control-center-marketplace
/plugin install agent-control-center-hook@agent-control-center
```

### 方式四：离线打包（无网环境 / 内网隔离）

1. 解压 `agent-control-center-marketplace-vX.Y.Z.zip` 到一个**固定位置**（如 `D:\tools\agent-control-center-marketplace\`），**安装后不要删**（目录市场会引用这个源路径）。
2. 双击 `install.bat`（自动检查 Node.js 并把市场注册进 `~/.codebuddy/settings.json`）。
3. 重启 CodeBuddy Code。

> 也可以用原生命令代替 `install.bat`：
> ```bash
> /plugin marketplace add D:/tools/agent-control-center-marketplace
> /plugin install agent-control-center-hook@agent-control-center
> ```

### 附注

- **不适用 HTTP URL 型市场**：本插件带 `hooks/scripts` 文件，官方规定这类插件不能用 HTTP URL 型市场分发（无法递归下载文件），必须用 Git 仓库 / ZIP / 本地目录。
- 状态行会在下一次会话启动时（SessionStart）自动写入 `~/.codebuddy/settings.json`。

## 配置

编辑插件的 `scripts/notify_config.json`：

```json
{
  "sound_enabled": true,   // 是否启用系统提示音
  "notify_url": "",        // 可选：任务完成时 POST 到的 webhook（企业微信/钉钉等）
  "log_enabled": false     // 是否写错误日志 notify_error.log
}
```

## 预览所有弹窗

```bash
node "插件安装目录/scripts/acc-hook.js" --preview
```

## 维护者说明

> 本仓库是发布快照，**以源码工程 `agent-control-center/` 为主**。改动在源码工程里做，然后同步到这里。

- **同步**：在源码工程目录下运行 `npm run sync-marketplace`（会自动覆盖拷贝插件 + 同步 `plugin.json` 版本到本仓库的 `marketplace.json`）。
- **版本号**：每次改代码先在源码工程 `npm run bump`（`plugin.json` patch +1），再 `npm run sync-marketplace`。不 bump 的话，成员的 CodeBuddy 会判定「已是最新」不拉取更新。
- **打包**（离线分发用）：

```powershell
Compress-Archive -Path "agent-control-center-marketplace\*" -DestinationPath "agent-control-center-marketplace-vX.Y.Z.zip" -Force
```

## 安全提示

插件与市场是高信任组件，会以你的用户权限执行任意代码。请仅从可信来源安装。
