#!/usr/bin/env node
"use strict";

/**
 * acc-hook.js — Agent Control Center 提醒插件（CodeBuddy Hook 入口）
 *
 * 架构（借鉴 absf-base）：WPF 弹窗 + 动态生成 PowerShell 脚本 + Base64 编码中文 + UTF-8 BOM，
 * 从根本上避开「命令行传中文参数」与「静态 .ps1 无 BOM 被 GBK 错读」这两类编码坑。
 *
 * 事件处理：
 *   PermissionRequest              → 三键决策弹窗；AskUserQuestion 走题目窗（decision.allow+updatedInput 跳过原生面板）
 *   Stop (stop_hook_active=false)  → 「任务完成」弹窗（含元信息栏 + 最后消息，不自动关）
 *   TaskCompleted                  → 静默（每个 todo 完成都触发，与 Stop 弹窗重复；完成信号统一由 Stop 承载）
 *   StopFailure                    → 「任务失败」弹窗（红色，带错误摘要）
 *   Notification(permission_prompt/AskUserQuestion) → 「题目展示」弹窗（transcript 反查题目+选项，
 *                                                     回终端作答；反查失败回退「提问提醒」通用窗）
 *   Notification(elicitation_dialog/agent_needs_input) → 「等待输入」弹窗（idle_prompt 空闲通知不弹，避免打扰）
 *   其它事件                       → 静默
 *
 * 硬性约定（CodeBuddy 安全契约）：
 *   1. stdout 只允许出现合法 hookSpecificOutput JSON 或什么都不出现；诊断一律 stderr / 日志文件
 *   2. 任何情况 exit 0，绝不影响 Agent
 *   3. fail-safe：弹窗超时/关闭/异常 → 零输出 → Agent 退回原生提示，绝不误放行
 *   4. 「同意并记住」只写精确原生规则（Bash(git status)），绝不写裸 ToolName / 通配符
 *      —— CodeBuddy 的 hook 路径不认 updatedPermissions，所以直接写 <project>/.codebuddy/settings.local.json
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const crypto = require("node:crypto");

// ============================================
// 配置和常量
// ============================================

const SCRIPT_DIR = __dirname;
const ERROR_LOG = path.join(SCRIPT_DIR, "notify_error.log");
const CONFIG_FILE = path.join(SCRIPT_DIR, "notify_config.json");
const STYLES_FILE = path.join(SCRIPT_DIR, "ui_styles.json");

const EVENT_PERMISSION_REQUEST = "PermissionRequest";
const EVENT_STOP = "Stop";
const EVENT_PRE_TOOL_USE = "PreToolUse";
const EVENT_STOP_FAILURE = "StopFailure";
const EVENT_NOTIFICATION = "Notification";
const TOOL_ASK_USER_QUESTION = "AskUserQuestion";

const SOUND_EXCLAMATION = "Exclamation";
const SOUND_ASTERISK = "Asterisk";
const SOUND_QUESTION = "Question";

function loadConfig() {
  const defaults = { notify_url: "", sound_enabled: true, log_enabled: false };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const userConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      return { ...defaults, ...userConfig };
    }
  } catch {
    /* 使用默认配置 */
  }
  return defaults;
}

const CONFIG = loadConfig();

// ============================================
// UI 样式配置
// ============================================

function loadStyles() {
  const defaults = {
    colors: {
      primary: "#4361ee", success: "#10b981", danger: "#ef4444",
      background: "#f8f9fa", containerBackground: "#f8f9fa", cardBackground: "#ffffff",
      metaBackground: "#e9ecef", border: "#dee2e6", labelText: "#212529",
      valueText: "#495057", descText: "#6c757d", white: "#ffffff",
      buttonHover: "#f8f9fa", secondaryHover: "#ced4da", shadowColor: "#000000",
    },
    fontSizes: { meta: 13, title: 13, content: 12, question: 12, optionLabel: 11, optionDesc: 10, message: 12, button: 12, customLabel: 9, customInput: 10 },
    fontFamily: { text: "Microsoft YaHei, Segoe UI", mono: "Consolas" },
    cornerRadius: { card: 8, meta: 6, button: 6, option: 6 },
    shadow: { blurRadius: 20, shadowDepth: 4, opacity: 0.12, direction: 315 },
    spacing: {
      metaPadding: "20,16", metaLineSpacing: 2, contentPadding: "20", titleMargin: "20,18,20,12",
      questionPadding: "20,12,20,12", buttonMargin: "0,0,16,0", optionMargin: "0,0,0,8",
      optionPadding: "12", sectionMargin: "0,0,0,12", customInputMargin: "20,12,20,8",
      customLabelMargin: "0,0,0,8", separatorMargin: "0,0,0,12",
    },
    button: { minHeight: 36 },
    window: { minWidth: 600, maxWidth: 800, minHeight: 200, maxHeight: 700 },
  };

  try {
    if (fs.existsSync(STYLES_FILE)) {
      const userStyles = JSON.parse(fs.readFileSync(STYLES_FILE, "utf8"));
      return {
        colors: { ...defaults.colors, ...userStyles.colors },
        fontSizes: { ...defaults.fontSizes, ...userStyles.fontSizes },
        fontFamily: { ...defaults.fontFamily, ...userStyles.fontFamily },
        cornerRadius: { ...defaults.cornerRadius, ...userStyles.cornerRadius },
        shadow: { ...defaults.shadow, ...userStyles.shadow },
        spacing: { ...defaults.spacing, ...userStyles.spacing },
        button: { ...defaults.button, ...userStyles.button },
        window: { ...defaults.window, ...userStyles.window },
      };
    }
  } catch {
    logError(`[Styles] Load error: ${(err && err.message) || "unknown"}\n`);
  }
  return defaults;
}

const UI_STYLES = loadStyles();

const PREVIEW_MODE = process.argv.includes("--preview");

// ============================================
// 工具函数
// ============================================

function logError(message) {
  if (CONFIG.log_enabled) {
    try { fs.appendFileSync(ERROR_LOG, message); } catch { /* ignore */ }
  }
}

/** 记录每次收到的钩子事件（诊断用，log_enabled 开启时写 notify_error.log） */
function logEvent(hookName, payload) {
  if (!CONFIG.log_enabled) return;
  const line = `${new Date().toISOString()} [EVENT] hook=${hookName} event=${payload.hook_event_name || "-"} tool=${payload.tool_name || "-"} notif=${payload.notification_type || "-"} session=${String(payload.session_id || "").slice(0, 8)} call=${payload.call_id || payload.tool_use_id || "-"}\n`;
  try { fs.appendFileSync(ERROR_LOG, line); } catch { /* ignore */ }
}

function encodeUtf8ToBase64(str) {
  return Buffer.from(String(str), "utf8").toString("base64");
}

/** 字段名兼容读取：snake_case / camelCase 双写 */
function extractField(data, fieldName, defaultValue = "") {
  const standardMappings = {
    session_id: ["session_id", "sessionId"],
    cwd: ["cwd", "working_directory"],
    transcript_path: ["transcript_path", "transcriptPath"],
    tool_name: ["tool_name", "toolName"],
    tool_input: ["tool_input", "toolInput"],
  };
  const fallbacks = standardMappings[fieldName] || [fieldName];
  for (const key of fallbacks) {
    const value = data[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return defaultValue;
}

/** 弹窗文案脱敏（password/token/secret/api_key 等不外泄到屏幕） */
function redactText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\b(password|passwd|token|secret|api[_-]?key|access[_-]?token|authorization|cookie|private[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, (_m, k, sep) => `${k}${sep}***REDACTED***`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "***REDACTED***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***REDACTED***");
}

// ============================================
// CodeBuddy 原生权限规则（「同意并记住」）
// ============================================

const ARG_KEY_BY_TOOL = {
  Bash: "command",
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  NotebookEdit: "notebook_path",
  NotebookRead: "notebook_path",
};

const GLOB_CHARS = /[*?[\]]/;

function normalizeContent(raw, opts) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (!cleaned) return null;
  if (opts && opts.rejectGlob && GLOB_CHARS.test(cleaned)) return null;
  if (cleaned.length > 200) return null;
  return cleaned;
}

/**
 * 为「同意并记住」派生精确原生规则；null = 派生不出 → 弹窗禁用「记住」，绝不写宽泛规则。
 */
function deriveNativeRule(payload) {
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
  if (!toolName) return null;

  const suggestions = Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions : [];
  const candidates = [];
  for (const item of suggestions) {
    if (!item || typeof item !== "object" || !item.rule || typeof item.rule !== "object") continue;
    if (item.rule.toolName !== toolName) continue;
    if (item.behavior && item.behavior !== "allow") continue;
    const content = normalizeContent(item.rule.ruleContent, { rejectGlob: false });
    if (!content) continue;
    candidates.push({ content, destination: item.destination || "unknown" });
  }
  if (candidates.length) {
    const preferred = candidates.find((c) => c.destination === "localSettings") || candidates[0];
    return { toolName, ruleContent: preferred.content, ruleText: `${toolName}(${preferred.content})` };
  }

  const key = ARG_KEY_BY_TOOL[toolName];
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : null;
  const content = key && input ? normalizeContent(input[key], { rejectGlob: true }) : null;
  return content ? { toolName, ruleContent: content, ruleText: `${toolName}(${content})` } : null;
}

/** 规则内容安全校验：精确或单层 `前缀:*`；拒绝空 / `*` / 任意 glob */
function isSafeRuleContent(content) {
  if (!content || content === "*") return false;
  const body = content.endsWith(":*") ? content.slice(0, -2).trim() : content;
  return body !== "" && !GLOB_CHARS.test(body);
}

/**
 * 「同意并记住」→ 写入 <cwd>/.codebuddy/settings.local.json（CodeBuddy 原生权限机制）。
 * 返回 { ok, changed, path, reason? }；写失败不影响本次放行。
 */
function persistNativeRule(projectPath, ruleText) {
  const target = path.join(projectPath, ".codebuddy", "settings.local.json");
  const result = { ok: false, changed: false, path: target };
  const match = /^([A-Za-z0-9_]+)\(([\s\S]+)\)$/.exec(typeof ruleText === "string" ? ruleText.trim() : "");
  if (!match || GLOB_CHARS.test(match[1]) || !isSafeRuleContent(match[2].trim())) {
    result.reason = "invalid_rule_text";
    return result;
  }
  let settings = {};
  try {
    const text = fs.readFileSync(target, "utf8").replace(/^\uFEFF/, "");
    if (text.trim()) {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        result.reason = "settings_not_object";
        return result;
      }
      settings = parsed;
    }
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      result.reason = "settings_unparseable";
      return result;
    }
  }
  const permissions = settings.permissions;
  if (permissions !== undefined && (typeof permissions !== "object" || permissions === null || Array.isArray(permissions))) {
    result.reason = "permissions_not_object";
    return result;
  }
  const allowRaw = permissions ? permissions.allow : undefined;
  if (allowRaw !== undefined && !Array.isArray(allowRaw)) {
    result.reason = "permissions_allow_not_array";
    return result;
  }
  const allow = Array.isArray(allowRaw) ? allowRaw.filter((x) => typeof x === "string") : [];
  if (allow.includes(ruleText)) {
    result.ok = true;
    return result;
  }
  const next = Object.assign({}, settings, {
    permissions: Object.assign({}, permissions && typeof permissions === "object" ? permissions : {}, {
      allow: allow.concat([ruleText]),
    }),
  });
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = path.join(path.dirname(target), `.settings.local.json.${process.pid}.${Date.now().toString(36)}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, target);
    result.ok = true;
    result.changed = true;
    return result;
  } catch (err) {
    result.reason = `write_error:${err && err.message}`;
    return result;
  }
}

/** 决策 → CodeBuddy 原生 hookSpecificOutput */
function buildDecisionOutput(action, reason) {
  if (action === "allow" || action === "remember") {
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
  }
  if (action === "deny") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: reason || "用户通过系统弹窗拒绝了本次操作。请不要绕过这个决定；如确有必要，请让用户重新授权。" },
      },
    };
  }
  return null;
}

// ============================================
// WPF 生成辅助
// ============================================

function getStyleHelpers() {
  const { colors, fontSizes, fontFamily, cornerRadius, shadow, spacing, button } = UI_STYLES;

  return {
    colors, fontSizes, fontFamily, cornerRadius, shadow, spacing,
    // 卡片阴影效果（DropShadowEffect）
    cardEffect: (varName) => `
$${varName}Effect = New-Object System.Windows.Media.Effects.DropShadowEffect
$${varName}Effect.Color = [System.Windows.Media.ColorConverter]::ConvertFromString('${colors.shadowColor}')
$${varName}Effect.BlurRadius = ${shadow.blurRadius}
$${varName}Effect.ShadowDepth = ${shadow.shadowDepth}
$${varName}Effect.Opacity = ${shadow.opacity}
$${varName}Effect.Direction = ${shadow.direction}
$${varName}.Effect = $${varName}Effect`,
    // 圆角按钮（ControlTemplate 实现 CornerRadius；variant: primary/secondary/success/danger）
    buttonStyle: (varName, variant) => {
      const isSecondary = variant === "secondary";
      const bg = isSecondary ? colors.metaBackground
        : (variant === "primary" ? colors.primary
          : variant === "success" ? colors.success : colors.danger);
      const fg = isSecondary ? colors.labelText : colors.white;
      const hoverCode = isSecondary
        ? `$${varName}.add_MouseEnter({ $this.Background = '${colors.secondaryHover}' })
$${varName}.add_MouseLeave({ $this.Background = '${colors.metaBackground}' })`
        : `$${varName}.add_MouseEnter({ $this.Opacity = 0.9 })
$${varName}.add_MouseLeave({ $this.Opacity = 1.0 })`;
      return `
$${varName}.Background = '${bg}'
$${varName}.Foreground = '${fg}'
$${varName}.BorderBrush = '${colors.border}'
$${varName}.BorderThickness = '0'
$${varName}.Padding = '12,8'
$${varName}.MinHeight = ${button.minHeight}
$${varName}.Margin = '${spacing.buttonMargin}'
$${varName}.FontSize = ${fontSizes.button}
$${varName}.FontWeight = 'Bold'
$${varName}.Cursor = 'Hand'
$${varName}.FontFamily = '${fontFamily.text}'
$${varName}Tpl = [System.Windows.Markup.XamlReader]::Parse('<ControlTemplate TargetType="Button" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"><Border Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="${cornerRadius.button}" Padding="{TemplateBinding Padding}"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border></ControlTemplate>')
$${varName}.Template = $${varName}Tpl
${hoverCode}`;
    },
    // 选项按钮样式（圆角 + 左对齐 + 白底边框 + hover，用于 AskUserQuestion 单选项）
    optionButtonStyle: (varName) => `
$${varName}.Background = '${colors.white}'
$${varName}.Foreground = '${colors.labelText}'
$${varName}.BorderBrush = '${colors.border}'
$${varName}.BorderThickness = '1'
$${varName}.Padding = '8'
$${varName}.Margin = '0,0,0,4'
$${varName}.Cursor = 'Hand'
$${varName}.HorizontalContentAlignment = 'Left'
$${varName}.FontFamily = '${fontFamily.text}'
$${varName}Tpl = [System.Windows.Markup.XamlReader]::Parse('<ControlTemplate TargetType="Button" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"><Border Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="${cornerRadius.option}" Padding="{TemplateBinding Padding}"><ContentPresenter HorizontalAlignment="Left" VerticalAlignment="Center"/></Border></ControlTemplate>')
$${varName}.Template = $${varName}Tpl
$${varName}.add_MouseEnter({ $this.Background = '${colors.buttonHover}' })
$${varName}.add_MouseLeave({ $this.Background = '${colors.white}' })`,
  };
}

/** 生成统一的元信息栏 PowerShell 代码（项目 / 会话 / 路径 + 附加字段） */
function generateMetaInfoBar(sessionId, cwd, additionalFields = []) {
  const projectName = cwd ? path.basename(cwd) : "Unknown";
  const sessionShort = sessionId ? sessionId.substring(0, 8) : "Unknown";

  const projectLabel_b64 = encodeUtf8ToBase64("📦 项目");
  const sessionLabel_b64 = encodeUtf8ToBase64("🔖 会话");
  const pathLabel_b64 = encodeUtf8ToBase64("📁 路径");

  const { colors, fontSizes, fontFamily, cornerRadius, spacing } = UI_STYLES;

  const additionalRows = additionalFields.map((field) => {
    const label_b64 = encodeUtf8ToBase64(field.label);
    // PS 单引号字符串不转义反斜杠，只 doubling 单引号（否则路径显示成 f:\\work）
    const value = String(field.value).replace(/'/g, "''");
    return `
$${field.id}Row = New-Object System.Windows.Controls.StackPanel
$${field.id}Row.Orientation = 'Horizontal'
$${field.id}Row.Margin = '0,0,0,${spacing.metaLineSpacing}'
$${field.id}Lbl = New-Object System.Windows.Controls.TextBlock
$${field.id}Lbl.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${label_b64}')) + ': '
$${field.id}Lbl.FontSize = ${fontSizes.meta}; $${field.id}Lbl.FontWeight = 'Bold'; $${field.id}Lbl.Foreground = '${colors.labelText}'; $${field.id}Lbl.FontFamily = '${fontFamily.text}'
$${field.id}Val = New-Object System.Windows.Controls.TextBlock
$${field.id}Val.Text = '${value}'
$${field.id}Val.FontSize = ${fontSizes.meta}; $${field.id}Val.Foreground = '${colors.valueText}'; $${field.id}Val.FontFamily = '${fontFamily.mono}'
${field.wrap ? `$${field.id}Val.TextWrapping = 'Wrap'` : ""}
$${field.id}Row.AddChild($${field.id}Lbl); $${field.id}Row.AddChild($${field.id}Val)
$metaPanel.AddChild($${field.id}Row)
`;
  }).join("\n");

  return `
# Meta info bar
$metaBar = New-Object System.Windows.Controls.Border
$metaBar.Background = '${colors.metaBackground}'
$metaBar.Padding = '${spacing.metaPadding}'
$metaBar.BorderBrush = '${colors.border}'
$metaBar.BorderThickness = '0,1,0,1'
$metaBar.CornerRadius = '${cornerRadius.meta}'
[System.Windows.Controls.Grid]::SetRow($metaBar, 1)

$metaPanel = New-Object System.Windows.Controls.StackPanel

$projectRow = New-Object System.Windows.Controls.StackPanel
$projectRow.Orientation = 'Horizontal'
$projectRow.Margin = '0,0,0,${spacing.metaLineSpacing}'
$projectLbl = New-Object System.Windows.Controls.TextBlock
$projectLbl.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${projectLabel_b64}')) + ': '
$projectLbl.FontSize = ${fontSizes.meta}; $projectLbl.FontWeight = 'Bold'; $projectLbl.Foreground = '${colors.labelText}'; $projectLbl.FontFamily = '${fontFamily.text}'
$projectVal = New-Object System.Windows.Controls.TextBlock
$projectVal.Text = '${projectName.replace(/'/g, "''")}'
$projectVal.FontSize = ${fontSizes.meta}; $projectVal.Foreground = '${colors.valueText}'; $projectVal.FontFamily = '${fontFamily.mono}'
$projectRow.AddChild($projectLbl); $projectRow.AddChild($projectVal)
$metaPanel.AddChild($projectRow)

$sessionRow = New-Object System.Windows.Controls.StackPanel
$sessionRow.Orientation = 'Horizontal'
$sessionRow.Margin = '0,0,0,${spacing.metaLineSpacing}'
$sessionLbl = New-Object System.Windows.Controls.TextBlock
$sessionLbl.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${sessionLabel_b64}')) + ': '
$sessionLbl.FontSize = ${fontSizes.meta}; $sessionLbl.FontWeight = 'Bold'; $sessionLbl.Foreground = '${colors.labelText}'; $sessionLbl.FontFamily = '${fontFamily.text}'
$sessionVal = New-Object System.Windows.Controls.TextBlock
$sessionVal.Text = '${sessionShort}'
$sessionVal.FontSize = ${fontSizes.meta}; $sessionVal.Foreground = '${colors.valueText}'; $sessionVal.FontFamily = '${fontFamily.mono}'
$sessionRow.AddChild($sessionLbl); $sessionRow.AddChild($sessionVal)
$metaPanel.AddChild($sessionRow)

$pathRow = New-Object System.Windows.Controls.StackPanel
$pathRow.Orientation = 'Horizontal'
$pathRow.Margin = '0,0,0,${spacing.metaLineSpacing}'
$pathLbl = New-Object System.Windows.Controls.TextBlock
$pathLbl.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${pathLabel_b64}')) + ': '
$pathLbl.FontSize = ${fontSizes.meta}; $pathLbl.FontWeight = 'Bold'; $pathLbl.Foreground = '${colors.labelText}'; $pathLbl.FontFamily = '${fontFamily.text}'
$pathVal = New-Object System.Windows.Controls.TextBlock
$pathVal.Text = '${cwd.replace(/'/g, "''")}'
$pathVal.FontSize = ${fontSizes.meta}; $pathVal.Foreground = '${colors.valueText}'; $pathVal.FontFamily = '${fontFamily.mono}'
$pathVal.TextWrapping = 'Wrap'
$pathRow.AddChild($pathLbl); $pathRow.AddChild($pathVal)
$metaPanel.AddChild($pathRow)

${additionalRows}

$metaBar.Child = $metaPanel
$grid.AddChild($metaBar)
`;
}

/** 执行 PowerShell 脚本：写临时 .ps1（UTF-8 BOM），execSync 阻塞直到弹窗关闭 */
function executePowerShellScript(scriptContent) {
  const tempFile = path.join(SCRIPT_DIR, `temp_ps_${process.pid}_${Date.now().toString(36)}.ps1`);
  try {
    const utf8BOM = Buffer.from([0xef, 0xbb, 0xbf]);
    const scriptBuffer = Buffer.from(scriptContent, "utf8");
    fs.writeFileSync(tempFile, Buffer.concat([utf8BOM, scriptBuffer]));
    const result = execSync(`powershell -NoProfile -STA -ExecutionPolicy Bypass -File "${tempFile}"`, {
      encoding: "utf8",
      timeout: 300000,
      windowsHide: true,
    });
    return result.trim();
  } finally {
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch { /* ignore */ }
  }
}

function playSound(soundType) {
  if (!CONFIG.sound_enabled) return;
  try {
    execSync(`powershell -Command "[System.Media.SystemSounds]::${soundType}.Play()"`, { windowsHide: true });
  } catch { /* ignore */ }
}

function sendHttpNotification(data) {
  const notifyUrl = (CONFIG.notify_url || "").trim();
  if (!notifyUrl) return;
  try {
    const sessionId = extractField(data, "session_id", "");
    const cwd = extractField(data, "cwd", "");
    const projectName = cwd ? path.basename(cwd) : "";
    const sessionShort = sessionId ? sessionId.substring(0, 8) : "";

    const msgParts = ["🤖 Agent 已完成任务"];
    if (projectName) msgParts.push(`📁 项目: ${projectName}`);
    if (sessionShort) msgParts.push(`🔑 会话: ${sessionShort}`);
    if (cwd) msgParts.push(`📂 目录: ${cwd}`);

    const msg = msgParts.join("\n");
    const urlObj = new URL(notifyUrl);
    const isHttps = urlObj.protocol === "https:";
    const lib = isHttps ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(msg) },
      timeout: 2000,
    };
    const req = lib.request(options, (res) => { res.on("data", () => {}); });
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.write(msg);
    req.end();
  } catch { /* ignore */ }
}

// ============================================
// PermissionRequest 处理（三键决策）
// ============================================

function handlePermissionRequest(data) {
  const toolName = extractField(data, "tool_name", "Unknown");

  if (toolName === TOOL_ASK_USER_QUESTION) {
    // 实测（0.1.7 日志）：AskUserQuestion 主流程不触发 PermissionRequest（走产品交互路径）。
    // 保留此分支作 forward-compat：若未来版本触发，则弹题目窗并跳过原生面板。
    return handlePermissionRequestForAsk(data);
  }

  playSound(SOUND_EXCLAMATION);

  const S = getStyleHelpers();
  const toolInput = extractField(data, "tool_input", {});
  const cwd = extractField(data, "cwd", "");
  const sessionId = extractField(data, "session_id", "");

  const native = deriveNativeRule(data);
  const rememberEnabled = Boolean(native);

  const details = Object.entries(toolInput)
    .filter(([k]) => k !== "description")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");

  const title_b64 = encodeUtf8ToBase64("Agent Control Center · 权限申请");
  const needAuth_b64 = encodeUtf8ToBase64("需要授权执行操作");
  const toolLabel_b64 = encodeUtf8ToBase64("工具");
  const detailsLabel_b64 = encodeUtf8ToBase64("参数详情");
  const allowBtn_b64 = encodeUtf8ToBase64("同意");
  const rememberBtn_b64 = encodeUtf8ToBase64("同意并记住");
  const denyBtn_b64 = encodeUtf8ToBase64("拒绝");
  const rememberTip_b64 = encodeUtf8ToBase64("无法派生精确规则（记住只会放宽授权范围），已禁用");

  const psScript = `
# 强制使用 UTF-8 编码
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore

$w = New-Object System.Windows.Window
$w.Title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${title_b64}'))
$w.Width = 700
$w.Height = 480
$w.WindowStartupLocation = 'CenterScreen'
$w.ResizeMode = 'NoResize'
$w.Background = '${S.colors.containerBackground}'
$w.Tag = ''
$w.Topmost = $true

$w.Add_Loaded({ $w.Activate(); $w.Focus() })

$grid = New-Object System.Windows.Controls.Grid
$grid.Margin = '0'

$row0 = New-Object System.Windows.Controls.RowDefinition; $row0.Height = 'Auto'
$row1 = New-Object System.Windows.Controls.RowDefinition; $row1.Height = 'Auto'
$row2 = New-Object System.Windows.Controls.RowDefinition; $row2.Height = '*'
$row3 = New-Object System.Windows.Controls.RowDefinition; $row3.Height = 'Auto'
$grid.RowDefinitions.Add($row0); $grid.RowDefinitions.Add($row1)
$grid.RowDefinitions.Add($row2); $grid.RowDefinitions.Add($row3)

# Title
$titlePanel = New-Object System.Windows.Controls.StackPanel
$titlePanel.Margin = '20,18,20,12'
[System.Windows.Controls.Grid]::SetRow($titlePanel, 0)

$titleText = New-Object System.Windows.Controls.TextBlock
$titleText.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${needAuth_b64}'))
$titleText.FontSize = ${S.fontSizes.title}; $titleText.FontWeight = 'Bold'; $titleText.Foreground = '${S.colors.labelText}'; $titleText.FontFamily = '${S.fontFamily.text}'
$titlePanel.AddChild($titleText)
$grid.AddChild($titlePanel)

${generateMetaInfoBar(sessionId, cwd)}

# Content
$contentFrame = New-Object System.Windows.Controls.Border
$contentFrame.Margin = '16,12,16,12'
$contentFrame.Background = '${S.colors.cardBackground}'
$contentFrame.CornerRadius = '${S.cornerRadius.card}'
$contentFrame.Padding = '16'
${S.cardEffect('contentFrame')}
[System.Windows.Controls.Grid]::SetRow($contentFrame, 2)

$scrollViewer = New-Object System.Windows.Controls.ScrollViewer
$scrollViewer.VerticalScrollBarVisibility = 'Auto'
$scrollViewer.HorizontalScrollBarVisibility = 'Disabled'

$card = New-Object System.Windows.Controls.StackPanel
$card.Margin = '0'

$toolLbl = New-Object System.Windows.Controls.TextBlock
$toolLbl.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${toolLabel_b64}'))
$toolLbl.FontSize = ${S.fontSizes.content}; $toolLbl.FontWeight = 'Bold'; $toolLbl.Foreground = '${S.colors.labelText}'; $toolLbl.FontFamily = '${S.fontFamily.text}'
$card.AddChild($toolLbl)

$toolBlock = New-Object System.Windows.Controls.TextBlock
$toolBlock.Text = "${toolName}"
$toolBlock.FontSize = ${S.fontSizes.content}; $toolBlock.FontWeight = 'Bold'
$toolBlock.Foreground = '${S.colors.valueText}'; $toolBlock.Margin = '0,4,0,12'
$toolBlock.FontFamily = '${S.fontFamily.mono}'
$card.AddChild($toolBlock)

$detailsLbl = New-Object System.Windows.Controls.TextBlock
$detailsLbl.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${detailsLabel_b64}'))
$detailsLbl.FontSize = ${S.fontSizes.content}; $detailsLbl.FontWeight = 'Bold'; $detailsLbl.Foreground = '${S.colors.labelText}'; $detailsLbl.FontFamily = '${S.fontFamily.text}'
$card.AddChild($detailsLbl)

$detailsBlock = New-Object System.Windows.Controls.TextBlock
$detailsBlock.Text = @'
${details}
'@
$detailsBlock.FontSize = ${S.fontSizes.content}; $detailsBlock.Foreground = '${S.colors.valueText}'
$detailsBlock.TextWrapping = 'Wrap'; $detailsBlock.FontFamily = '${S.fontFamily.mono}'
$detailsBlock.Margin = '0,4,0,0'
$card.AddChild($detailsBlock)

$scrollViewer.Content = $card
$contentFrame.Child = $scrollViewer
$grid.AddChild($contentFrame)

# Buttons（左→右：拒绝 / 同意并记住 / 同意）
$btnPanel = New-Object System.Windows.Controls.StackPanel
$btnPanel.Orientation = 'Horizontal'
$btnPanel.HorizontalAlignment = 'Center'
$btnPanel.Margin = '16,12,16,16'
[System.Windows.Controls.Grid]::SetRow($btnPanel, 3)

$denyBtn = New-Object System.Windows.Controls.Button
$denyBtn.Content = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${denyBtn_b64}'))
${S.buttonStyle('denyBtn', 'danger')}
$denyBtn.Add_Click({ $w.Tag = 'deny'; $w.DialogResult = $true; $w.Close() })
$btnPanel.AddChild($denyBtn)

$rememberBtn = New-Object System.Windows.Controls.Button
$rememberBtn.Content = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${rememberBtn_b64}'))
${S.buttonStyle('rememberBtn', 'primary')}
$rememberBtn.Add_Click({ $w.Tag = 'remember'; $w.DialogResult = $true; $w.Close() })
$btnPanel.AddChild($rememberBtn)

$allowBtn = New-Object System.Windows.Controls.Button
$allowBtn.Content = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${allowBtn_b64}'))
${S.buttonStyle('allowBtn', 'success')}
$allowBtn.Add_Click({ $w.Tag = 'allow'; $w.DialogResult = $true; $w.Close() })
$btnPanel.AddChild($allowBtn)

${rememberEnabled ? "" : `
$rememberBtn.IsEnabled = $false
$rememberBtn.Opacity = 0.5
$rememberTip = New-Object System.Windows.Controls.ToolTip
$rememberTip.Content = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${rememberTip_b64}'))
$rememberBtn.ToolTip = $rememberTip
`}

$grid.AddChild($btnPanel)

$w.Content = $grid
$null = $w.ShowDialog()
Write-Output $w.Tag
`;

  try {
    const result = executePowerShellScript(psScript);

    if (result === "remember") {
      const projectPath = typeof cwd === "string" && cwd ? cwd : "";
      if (native && projectPath) {
        const r = persistNativeRule(projectPath, native.ruleText);
        logError(`acc-hook: remember ${r.ok ? (r.changed ? "added" : "already_present") : "skipped"} ${native.ruleText} ${r.reason || ""}\n`);
      } else {
        // 拿不到精确规则：本次照常放行，但绝不写宽泛规则
        logError("acc-hook: remember skipped (no precise rule derivable)\n");
      }
    }

    const decision = buildDecisionOutput(result === "remember" ? "allow" : result, "用户通过系统弹窗拒绝了本次操作。请不要绕过这个决定；如确有必要，请让用户重新授权。");
    if (decision && !PREVIEW_MODE) process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch (err) {
    logError(`[PermissionRequest] Error: ${(err && err.message) || "unknown"}\n`);
  }
}

// ============================================
// AskUserQuestion 防迟到 / 防重复（跨进程接力）
// ============================================
//
// 时序 bug 背景：CodeBuddy 运行时会在多个路径触发 PreToolUse 钩子
// （needsApproval 未命中缓存时，executeToolWithHooks 会补跑），且 CLI 原生
// 问题面板可能先行收集答案。本插件的 WPF 弹窗启动慢（node→PowerShell→WPF 数秒），
// 慢启动 + 重复触发会导致「用户已作答后弹窗才出现」「同一问题弹两次」。
//
// 对策：在系统临时目录写状态文件做跨进程去重与答案接力。键 = session + call_id
// + questions 摘要（同一工具调用的多次触发同键；新调用新键，不会误复用）：
//   state=pending       有实例正在弹窗（重复实例等待其结果，不重复弹）
//   state=answered      问题已由本插件弹窗作答，后续触发直接复用答案输出
//   state=fell_through  前一实例「知道了（回到 CLI）」，后续触发同样静默回退

const ASK_STATE_DIR = path.join(os.tmpdir(), "acc-hook-ask");
const ASK_STATE_TTL_MS = 10 * 60 * 1000; // 状态文件最长保留
const ASK_WAIT_MS = 240 * 1000; // 等待在途实例作答的最长时间（< PreToolUse 钩子 300s 超时）

function askStateKey(data, questions) {
  const sessionId = String(extractField(data, "session_id", ""));
  const callId = String(data.call_id || data.tool_use_id || data.callId || data.toolUseId || "");
  const digest = crypto.createHash("sha1").update(JSON.stringify(questions)).digest("hex").slice(0, 12);
  return `${(sessionId || "nosession").substring(0, 8)}-${callId || "nocall"}-${digest}`;
}

function askStatePath(key) {
  return path.join(ASK_STATE_DIR, `ask-${key}.json`);
}

function readAskState(key) {
  try {
    return JSON.parse(fs.readFileSync(askStatePath(key), "utf8"));
  } catch {
    return null;
  }
}

function writeAskState(key, patch) {
  try {
    fs.mkdirSync(ASK_STATE_DIR, { recursive: true });
    const prev = readAskState(key) || {};
    fs.writeFileSync(askStatePath(key), `${JSON.stringify({ ...prev, ...patch })}\n`, "utf8");
  } catch {
    /* 状态文件失败不影响主流程 */
  }
}

function removeAskState(key) {
  try {
    fs.unlinkSync(askStatePath(key));
  } catch {
    /* ignore */
  }
}

function pidAlive(pid) {
  const p = Number(pid);
  if (!p) return false;
  if (p === process.pid) return true;
  try {
    process.kill(p, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function cleanupStaleAskStates() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(ASK_STATE_DIR)) {
      const p = path.join(ASK_STATE_DIR, f);
      try {
        if (now - fs.statSync(p).mtimeMs > ASK_STATE_TTL_MS) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/** answers 是否已覆盖全部问题（运行时把 CLI 面板答案并入 tool_input 后，弹窗不再有意义） */
function answersComplete(questions, answers) {
  if (!answers || typeof answers !== "object") return false;
  return questions.every((q) => {
    const v = answers[q && q.question];
    return Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.length > 0;
  });
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 无法阻塞时跳过等待，直接按当前状态处理 */
  }
}

/**
 * 处理同一工具调用的重复 PreToolUse 触发。
 * 返回："fell_through"（跟随回退，静默退出）| 对象（复用答案）| null（无重复，继续弹窗）
 */
function resolveDuplicateAsk(key) {
  let st = readAskState(key);
  if (!st) return null;

  if (st.state === "answered" || st.state === "fell_through") {
    removeAskState(key);
    return st.state === "answered" ? (st.answer && typeof st.answer === "object" ? st.answer : "fell_through") : "fell_through";
  }

  // state=pending：前一实例正在弹窗，等待其作答/回退/退出
  const deadline = Date.now() + ASK_WAIT_MS;
  while (Date.now() < deadline) {
    sleepSync(500);
    st = readAskState(key);
    if (!st) return null; // 状态文件被清理 → 接管弹窗
    if (st.state === "answered") {
      removeAskState(key);
      return st.answer && typeof st.answer === "object" ? st.answer : "fell_through";
    }
    if (st.state === "fell_through") {
      removeAskState(key);
      return "fell_through";
    }
    if (!pidAlive(st.pid)) {
      // 前一实例进程已死且未留下结果 → 接管弹窗
      removeAskState(key);
      return null;
    }
  }
  return null; // 等待超时（罕见）→ 接管弹窗
}

// ============================================
// PreToolUse 处理（AskUserQuestion）
// ============================================

function runAskDialog(data) {
  const S = getStyleHelpers();
  const toolInput = extractField(data, "tool_input", {});
  const questions = toolInput.questions || [];
  const cwd = extractField(data, "cwd", "");
  const sessionId = extractField(data, "session_id", "");

  if (questions.length === 0) return null;

  // —— 防迟到 / 防重复 ——
  const askKey = askStateKey(data, questions);
  if (!PREVIEW_MODE) {
    cleanupStaleAskStates();

    // a) 答案已在 tool_input（上游已作答）→ 弹窗已无意义，静默回退
    if (answersComplete(questions, toolInput.answers)) {
      logError("acc-hook: ask skipped (answers already present in tool_input)\n");
      return null;
    }

    // b) 同一工具调用的重复触发：复用既有答案 / 跟随前一实例回退，不重复弹窗
    const dupAnswer = resolveDuplicateAsk(askKey);
    if (dupAnswer === "fell_through") return null;
    if (dupAnswer && typeof dupAnswer === "object") {
      logError("acc-hook: ask answer reused from duplicate trigger\n");
      return dupAnswer;
    }

    writeAskState(askKey, { state: "pending", pid: process.pid, ts: Date.now() });
  }

  const q = questions[0];
  const options = q.options || [];
  const multiSelect = q.multiSelect === true;

  const header_b64 = encodeUtf8ToBase64(q.header || "问题");
  const question_b64 = encodeUtf8ToBase64(q.question || "");
  const modeLabel_b64 = encodeUtf8ToBase64("类型");
  const modeValue_b64 = encodeUtf8ToBase64(multiSelect ? "多选" : "单选");

  const additionalFields = [
    { id: "qtype", label: "📝 类型", value: multiSelect ? "多选" : "单选", wrap: false },
  ];

  const optionButtons = options
    .map((opt, idx) => {
      const label_b64 = encodeUtf8ToBase64(opt.label || `选项 ${idx + 1}`);
      const desc_b64 = encodeUtf8ToBase64(opt.description || "");
      const labelEscaped = (opt.label || "").replace(/'/g, "''");

      const contentCode = `
$btnContent${idx} = New-Object System.Windows.Controls.StackPanel
$btnLabel${idx} = New-Object System.Windows.Controls.TextBlock
$btnLabel${idx}.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${label_b64}'))
$btnLabel${idx}.FontWeight = 'Bold'; $btnLabel${idx}.FontSize = ${S.fontSizes.optionLabel}; $btnLabel${idx}.Foreground = '${S.colors.labelText}'; $btnLabel${idx}.FontFamily = '${S.fontFamily.text}'
$btnContent${idx}.AddChild($btnLabel${idx})
$btnDesc${idx} = New-Object System.Windows.Controls.TextBlock
$btnDesc${idx}.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${desc_b64}'))
$btnDesc${idx}.FontSize = ${S.fontSizes.optionDesc}; $btnDesc${idx}.Foreground = '${S.colors.descText}'; $btnDesc${idx}.Margin = '0,3,0,0'; $btnDesc${idx}.TextWrapping = 'Wrap'; $btnDesc${idx}.FontFamily = '${S.fontFamily.text}'
$btnContent${idx}.AddChild($btnDesc${idx})
`;

      if (multiSelect) {
        return `
$btn${idx} = New-Object System.Windows.Controls.CheckBox
$btn${idx}.Tag = '${labelEscaped}'
$btn${idx}.Margin = '0,0,0,4'; $btn${idx}.Padding = '8'
$btn${idx}.Background = '${S.colors.white}'; $btn${idx}.BorderBrush = '${S.colors.border}'; $btn${idx}.BorderThickness = '1'
$btn${idx}.Cursor = 'Hand'; $btn${idx}.FontFamily = '${S.fontFamily.text}'; $btn${idx}.VerticalContentAlignment = 'Center'
${contentCode}
$btn${idx}.Content = $btnContent${idx}
$optionsPanel.AddChild($btn${idx})
`;
      }

      return `
$btn${idx} = New-Object System.Windows.Controls.Button
$btn${idx}.Tag = '${labelEscaped}'
${S.optionButtonStyle("btn" + idx)}
${contentCode}
$btn${idx}.Content = $btnContent${idx}
$btn${idx}.Add_Click({ $w.Tag = $this.Tag; $w.DialogResult = $true; $w.Close() })
$optionsPanel.AddChild($btn${idx})
`;
    })
    .join("\n");

  const customInputLabel_b64 = encodeUtf8ToBase64(multiSelect ? "补充自定义答案（与勾选项一起提交）:" : "或输入自定义答案:");
  const submitCustom_b64 = encodeUtf8ToBase64("提交自定义答案");
  const submitMulti_b64 = encodeUtf8ToBase64("提交多选答案");
  const knowBtn_b64 = encodeUtf8ToBase64("知道了（回到 CLI）");

  const psScript = `
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore

[System.Media.SystemSounds]::Question.Play()

$w = New-Object System.Windows.Window
$w.Title = 'Agent Control Center · 问题'
$w.Width = 700
$w.Height = 650
$w.WindowStartupLocation = 'CenterScreen'
$w.ResizeMode = 'NoResize'
$w.Background = '${S.colors.containerBackground}'
$w.Tag = ''
$w.Topmost = $true

$w.Add_Loaded({ $w.Activate(); $w.Focus() })

$grid = New-Object System.Windows.Controls.Grid
$grid.Margin = '0'

$row0 = New-Object System.Windows.Controls.RowDefinition; $row0.Height = 'Auto'
$row1 = New-Object System.Windows.Controls.RowDefinition; $row1.Height = 'Auto'
$row2 = New-Object System.Windows.Controls.RowDefinition; $row2.Height = 'Auto'
$row3 = New-Object System.Windows.Controls.RowDefinition; $row3.Height = '*'
$row4 = New-Object System.Windows.Controls.RowDefinition; $row4.Height = 'Auto'
$row5 = New-Object System.Windows.Controls.RowDefinition; $row5.Height = 'Auto'
$grid.RowDefinitions.Add($row0); $grid.RowDefinitions.Add($row1)
$grid.RowDefinitions.Add($row2); $grid.RowDefinitions.Add($row3)
$grid.RowDefinitions.Add($row4); $grid.RowDefinitions.Add($row5)

$titlePanel = New-Object System.Windows.Controls.StackPanel
$titlePanel.Margin = '20,18,20,12'
[System.Windows.Controls.Grid]::SetRow($titlePanel, 0)

$titleBlock = New-Object System.Windows.Controls.TextBlock
$titleBlock.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${header_b64}'))
$titleBlock.FontSize = ${S.fontSizes.title}
$titleBlock.FontWeight = 'Bold'
$titleBlock.Foreground = '${S.colors.labelText}'
$titleBlock.FontFamily = '${S.fontFamily.text}'
$titlePanel.AddChild($titleBlock)
$grid.AddChild($titlePanel)

${generateMetaInfoBar(sessionId, cwd, additionalFields)}

$questionPanel = New-Object System.Windows.Controls.Border
$questionPanel.Padding = '20,12,20,12'
[System.Windows.Controls.Grid]::SetRow($questionPanel, 2)

$questionBlock = New-Object System.Windows.Controls.TextBlock
$questionBlock.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${question_b64}'))
$questionBlock.FontSize = ${S.fontSizes.question}
$questionBlock.FontWeight = 'Bold'
$questionBlock.Foreground = '${S.colors.labelText}'
$questionBlock.FontFamily = '${S.fontFamily.text}'
$questionBlock.TextWrapping = 'Wrap'
$questionPanel.Child = $questionBlock
$grid.AddChild($questionPanel)

$scrollViewer = New-Object System.Windows.Controls.ScrollViewer
$scrollViewer.VerticalScrollBarVisibility = 'Auto'
$scrollViewer.HorizontalScrollBarVisibility = 'Disabled'
$scrollViewer.Margin = '20,0,20,0'
[System.Windows.Controls.Grid]::SetRow($scrollViewer, 3)

$optionsPanel = New-Object System.Windows.Controls.StackPanel
${optionButtons}

$scrollViewer.Content = $optionsPanel
$grid.AddChild($scrollViewer)

$customInputPanel = New-Object System.Windows.Controls.StackPanel
$customInputPanel.Margin = '20,12,20,8'
[System.Windows.Controls.Grid]::SetRow($customInputPanel, 4)

$separator2 = New-Object System.Windows.Controls.Border
$separator2.Height = 1
$separator2.Background = '${S.colors.border}'
$separator2.Margin = '0,0,0,12'
$customInputPanel.AddChild($separator2)

$customLabel = New-Object System.Windows.Controls.TextBlock
$customLabel.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${customInputLabel_b64}'))
$customLabel.FontSize = ${S.fontSizes.customLabel}
$customLabel.FontWeight = 'Bold'
$customLabel.Foreground = '${S.colors.labelText}'
$customLabel.FontFamily = '${S.fontFamily.text}'
$customLabel.Margin = '0,0,0,8'
$customInputPanel.AddChild($customLabel)

$customInput = New-Object System.Windows.Controls.TextBox
$customInput.Padding = '8'
$customInput.FontSize = ${S.fontSizes.customInput}
$customInput.FontFamily = '${S.fontFamily.text}'
$customInput.Background = '${S.colors.white}'
$customInput.BorderBrush = '${S.colors.border}'
$customInputPanel.AddChild($customInput)

$grid.AddChild($customInputPanel)

$btnPanel = New-Object System.Windows.Controls.StackPanel
$btnPanel.Orientation = 'Horizontal'
$btnPanel.HorizontalAlignment = 'Center'
$btnPanel.Margin = '20,12,20,16'
[System.Windows.Controls.Grid]::SetRow($btnPanel, 5)

$knowBtn = New-Object System.Windows.Controls.Button
$knowBtn.Content = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${knowBtn_b64}'))
${S.buttonStyle('knowBtn', 'secondary')}
$knowBtn.Add_Click({ $w.Tag = ''; $w.DialogResult = $false; $w.Close() })
$btnPanel.AddChild($knowBtn)

${multiSelect ? `
$submitMulti = New-Object System.Windows.Controls.Button
$submitMulti.Content = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${submitMulti_b64}'))
${S.buttonStyle('submitMulti', 'primary')}
$submitMulti.Add_Click({
  $selected = @()
  foreach ($child in $optionsPanel.Children) {
    if ($child -is [System.Windows.Controls.CheckBox] -and $child.IsChecked -eq $true) {
      $selected += $child.Tag
    }
  }
  $customText = $customInput.Text.Trim()
  if ($customText -ne '') { $selected += $customText }
  if ($selected.Count -gt 0) {
    $json = $selected | ConvertTo-Json -Compress
    if ($selected.Count -eq 1) { $json = '[' + $json + ']' }
    $w.Tag = $json
    $w.DialogResult = $true
    $w.Close()
  }
})
$btnPanel.AddChild($submitMulti)
` : ""}

${!multiSelect ? `
$submitCustom = New-Object System.Windows.Controls.Button
$submitCustom.Content = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${submitCustom_b64}'))
${S.buttonStyle('submitCustom', 'success')}
$submitCustom.Add_Click({
  $text = $customInput.Text.Trim()
  if ($text -ne '') {
    $w.Tag = $text
    $w.DialogResult = $true
    $w.Close()
  }
})
$btnPanel.AddChild($submitCustom)
` : ""}

$grid.AddChild($btnPanel)

$w.Content = $grid
$null = $w.ShowDialog()
Write-Output $w.Tag
`;

  try {
    const selectedOption = executePowerShellScript(psScript);

    if (selectedOption) {
      const answers = {};
      if (multiSelect) {
        let selectedArr;
        try {
          selectedArr = JSON.parse(selectedOption);
          if (!Array.isArray(selectedArr)) selectedArr = [String(selectedArr)];
        } catch {
          selectedArr = [selectedOption];
        }
        answers[q.question] = selectedArr;
      } else {
        answers[q.question] = selectedOption;
      }

      if (!PREVIEW_MODE) writeAskState(askKey, { state: "answered", answer: answers });
      return answers;
    }

    // 「知道了（回到 CLI）」：回退原生面板；记录回退状态让重复触发同样静默
    if (!PREVIEW_MODE) writeAskState(askKey, { state: "fell_through" });
    return null;
  } catch (err) {
    if (!PREVIEW_MODE) writeAskState(askKey, { state: "fell_through" });
    logError(`[AskDialog] Error: ${(err && err.message) || "unknown"}\n`);
    return null;
  }
}

// ============================================
// Notification 路径（AskUserQuestion 题目展示弹窗）
// ============================================
//
// 架构约束（2.156/2.157 实测 + 逆向 2.157.0 bundle）：AskUserQuestion 走「产品交互路径」，
// 原生 CLI 面板出现前唯一触发的钩子是 Notification(permission_prompt)（message 含工具名、
// payload 无题目但带 transcript_path）；PermissionRequest / PreToolUse 均不触发，且 CLI 面板
// 等待期间无法注入答案。因此桌面侧做「题目同步展示」：从 transcript 反查最后一条未作答的
// AskUserQuestion，把题目+选项弹成系统窗口，用户回终端作答；答案注入仍由
// PermissionRequest forward-compat 分支承担（未来版本若触发即完整接管）。
//
// 注意：HandleInterruptions 会先 await Notification 钩子再显示 CLI 面板，弹窗若一直开着会
// 阻塞面板出现 → 加 120s 自动关闭（可用 ACC_ASK_AUTOCLOSE_S 环境变量覆盖，测试用）。

const ASK_DISPLAY_AUTOCLOSE_S = Number(process.env.ACC_ASK_AUTOCLOSE_S) || 120;

/**
 * 从 transcript（JSONL）反查最后一条未作答的 AskUserQuestion。
 * 待答 = type:function_call 且 name:AskUserQuestion，且其后没有同 callId 的 function_call_result。
 * 返回 { questions, callId } 或 null。
 */
function extractPendingAskFromTranscript(transcriptPath) {
  let text;
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  let call = null;
  let callIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes("AskUserQuestion") || !line.includes("function_call")) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o && o.type === "function_call" && o.name === TOOL_ASK_USER_QUESTION) {
      call = o;
      callIdx = i;
      break;
    }
  }
  if (!call) return null;
  if (call.callId) {
    for (let i = callIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(call.callId)) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o && o.type === "function_call_result" && o.callId === call.callId) return null; // 已作答
    }
  }
  let args = call.arguments;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return null; }
  }
  const questions = args && Array.isArray(args.questions)
    ? args.questions.filter((q) => q && typeof q === "object")
    : [];
  if (questions.length === 0) return null;
  return { questions, callId: typeof call.callId === "string" ? call.callId : "" };
}

function displayAskStateKey(sessionId, seed) {
  const digest = crypto.createHash("sha1").update(String(seed || "")).digest("hex").slice(0, 12);
  return `${String(sessionId || "nosession").substring(0, 8)}-display-${digest}`;
}

function generateAskDisplayPs({ questions, sessionId, cwd }) {
  const S = getStyleHelpers();
  const title_b64 = encodeUtf8ToBase64("Agent Control Center · Agent 提问");
  const heading_b64 = encodeUtf8ToBase64("Agent 正在向您提问");
  const tip_b64 = encodeUtf8ToBase64(`请在终端的问题面板中作答；本窗口仅同步展示题目，${ASK_DISPLAY_AUTOCLOSE_S} 秒后自动关闭。`);
  const knowBtn_b64 = encodeUtf8ToBase64("知道了（回终端作答）");

  const additionalFields = [
    { id: "qcount", label: "❓ 问题数", value: String(questions.length), wrap: false },
  ];

  const sections = questions.map((q, qi) => {
    const header_b64 = encodeUtf8ToBase64(q.header || `问题 ${qi + 1}`);
    const question_b64 = encodeUtf8ToBase64(q.question || "");
    const multiTag_b64 = q.multiSelect === true ? encodeUtf8ToBase64("（可多选）") : "";

    const optionCards = (Array.isArray(q.options) ? q.options : []).map((opt, oi) => {
      const label_b64 = encodeUtf8ToBase64((opt && opt.label) || `选项 ${oi + 1}`);
      const desc_b64 = encodeUtf8ToBase64((opt && opt.description) || "");
      return `
$optCard${qi}_${oi} = New-Object System.Windows.Controls.Border
$optCard${qi}_${oi}.Background = '${S.colors.white}'
$optCard${qi}_${oi}.BorderBrush = '${S.colors.border}'
$optCard${qi}_${oi}.BorderThickness = '1'
$optCard${qi}_${oi}.CornerRadius = '${S.cornerRadius.option}'
$optCard${qi}_${oi}.Padding = '10,8'
$optCard${qi}_${oi}.Margin = '0,0,0,6'
$optInner${qi}_${oi} = New-Object System.Windows.Controls.StackPanel
$optLabel${qi}_${oi} = New-Object System.Windows.Controls.TextBlock
$optLabel${qi}_${oi}.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${label_b64}'))
$optLabel${qi}_${oi}.FontWeight = 'Bold'; $optLabel${qi}_${oi}.FontSize = ${S.fontSizes.optionLabel}; $optLabel${qi}_${oi}.Foreground = '${S.colors.labelText}'; $optLabel${qi}_${oi}.FontFamily = '${S.fontFamily.text}'
$optInner${qi}_${oi}.AddChild($optLabel${qi}_${oi})
$optDesc${qi}_${oi} = New-Object System.Windows.Controls.TextBlock
$optDesc${qi}_${oi}.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${desc_b64}'))
$optDesc${qi}_${oi}.FontSize = ${S.fontSizes.optionDesc}; $optDesc${qi}_${oi}.Foreground = '${S.colors.descText}'; $optDesc${qi}_${oi}.TextWrapping = 'Wrap'; $optDesc${qi}_${oi}.Margin = '0,2,0,0'; $optDesc${qi}_${oi}.FontFamily = '${S.fontFamily.text}'
$optInner${qi}_${oi}.AddChild($optDesc${qi}_${oi})
$optCard${qi}_${oi}.Child = $optInner${qi}_${oi}
$qPanel${qi}.AddChild($optCard${qi}_${oi})
`;
    }).join("\n");

    const multiTagCode = multiTag_b64 ? `
$multiTag${qi} = New-Object System.Windows.Controls.TextBlock
$multiTag${qi}.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${multiTag_b64}'))
$multiTag${qi}.FontSize = ${S.fontSizes.optionDesc}; $multiTag${qi}.Foreground = '${S.colors.primary}'; $multiTag${qi}.FontWeight = 'Bold'; $multiTag${qi}.FontFamily = '${S.fontFamily.text}'; $multiTag${qi}.Margin = '0,2,0,0'
$qPanel${qi}.AddChild($multiTag${qi})
` : "";

    return `
# —— 问题 ${qi + 1} ——
$qPanel${qi} = New-Object System.Windows.Controls.StackPanel
$qPanel${qi}.Margin = '0,0,0,16'

$qHeader${qi} = New-Object System.Windows.Controls.TextBlock
$qHeader${qi}.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${header_b64}'))
$qHeader${qi}.FontSize = ${S.fontSizes.title}; $qHeader${qi}.FontWeight = 'Bold'; $qHeader${qi}.Foreground = '${S.colors.primary}'; $qHeader${qi}.FontFamily = '${S.fontFamily.text}'
$qPanel${qi}.AddChild($qHeader${qi})
${multiTagCode}
$qText${qi} = New-Object System.Windows.Controls.TextBlock
$qText${qi}.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${question_b64}'))
$qText${qi}.FontSize = ${S.fontSizes.question}; $qText${qi}.FontWeight = 'Bold'; $qText${qi}.Foreground = '${S.colors.labelText}'; $qText${qi}.TextWrapping = 'Wrap'; $qText${qi}.FontFamily = '${S.fontFamily.text}'; $qText${qi}.Margin = '0,4,0,10'
$qPanel${qi}.AddChild($qText${qi})
${optionCards}
$askPanel.AddChild($qPanel${qi})
`;
  }).join("\n");

  const height = Math.min(760, Math.max(460, 320 + questions.length * 150));

  return `
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore

[System.Media.SystemSounds]::Question.Play()

$w = New-Object System.Windows.Window
$w.Title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${title_b64}'))
$w.Width = 700
$w.Height = ${height}
$w.WindowStartupLocation = 'CenterScreen'
$w.ResizeMode = 'NoResize'
$w.Background = '${S.colors.containerBackground}'

$grid = New-Object System.Windows.Controls.Grid
$grid.Margin = '0'

$row0 = New-Object System.Windows.Controls.RowDefinition; $row0.Height = 'Auto'
$row1 = New-Object System.Windows.Controls.RowDefinition; $row1.Height = 'Auto'
$row2 = New-Object System.Windows.Controls.RowDefinition; $row2.Height = '*'
$row3 = New-Object System.Windows.Controls.RowDefinition; $row3.Height = 'Auto'
$row4 = New-Object System.Windows.Controls.RowDefinition; $row4.Height = 'Auto'
$grid.RowDefinitions.Add($row0); $grid.RowDefinitions.Add($row1)
$grid.RowDefinitions.Add($row2); $grid.RowDefinitions.Add($row3)
$grid.RowDefinitions.Add($row4)

$titlePanel = New-Object System.Windows.Controls.StackPanel
$titlePanel.Margin = '20,18,20,12'
[System.Windows.Controls.Grid]::SetRow($titlePanel, 0)

$titleText = New-Object System.Windows.Controls.TextBlock
$titleText.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${heading_b64}'))
$titleText.FontSize = ${S.fontSizes.title}; $titleText.FontWeight = 'Bold'; $titleText.Foreground = '${S.colors.primary}'; $titleText.FontFamily = '${S.fontFamily.text}'
$titlePanel.AddChild($titleText)
$grid.AddChild($titlePanel)

${generateMetaInfoBar(sessionId, cwd, additionalFields)}

$scrollViewer = New-Object System.Windows.Controls.ScrollViewer
$scrollViewer.VerticalScrollBarVisibility = 'Auto'
$scrollViewer.HorizontalScrollBarVisibility = 'Disabled'
$scrollViewer.Margin = '20,12,20,0'
[System.Windows.Controls.Grid]::SetRow($scrollViewer, 2)

$askPanel = New-Object System.Windows.Controls.StackPanel
${sections}

$scrollViewer.Content = $askPanel
$grid.AddChild($scrollViewer)

$tipBlock = New-Object System.Windows.Controls.TextBlock
$tipBlock.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${tip_b64}'))
$tipBlock.FontSize = ${S.fontSizes.optionDesc}; $tipBlock.Foreground = '${S.colors.descText}'; $tipBlock.TextWrapping = 'Wrap'; $tipBlock.FontFamily = '${S.fontFamily.text}'
$tipBlock.Margin = '20,10,20,0'
[System.Windows.Controls.Grid]::SetRow($tipBlock, 3)
$grid.AddChild($tipBlock)

$btnPanel = New-Object System.Windows.Controls.StackPanel
$btnPanel.HorizontalAlignment = 'Center'
$btnPanel.Margin = '16,12,16,16'
[System.Windows.Controls.Grid]::SetRow($btnPanel, 4)

$knowBtn = New-Object System.Windows.Controls.Button
$knowBtn.Content = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${knowBtn_b64}'))
$knowBtn.MinWidth = 180
${S.buttonStyle('knowBtn', 'primary')}
$knowBtn.Add_Click({ $w.Close() })
$btnPanel.AddChild($knowBtn)
$grid.AddChild($btnPanel)

$w.Content = $grid

$w.Add_Loaded({
    $w.Topmost = $true
    $w.Activate()
    $knowBtn.Focus()
    $w.Topmost = $false
})

$w.Add_KeyDown({
    param($sender, $e)
    if ($e.Key -eq 'Escape' -or $e.Key -eq 'Return') { $w.Close() }
})

$autoCloseTimer = New-Object System.Windows.Threading.DispatcherTimer
$autoCloseTimer.Interval = [TimeSpan]::FromSeconds(${ASK_DISPLAY_AUTOCLOSE_S})
$autoCloseTimer.Add_Tick({ $autoCloseTimer.Stop(); $w.Close() })
$autoCloseTimer.Start()

$w.ShowDialog() | Out-Null
$autoCloseTimer.Stop()
`;
}

/** 弹出题目展示窗（带跨进程去重：同一问题只弹一次） */
function showAskDisplayPopup(data, extracted) {
  const sessionId = extractField(data, "session_id", "");
  const cwd = extractField(data, "cwd", "");
  const askKey = displayAskStateKey(sessionId, extracted.callId || JSON.stringify(extracted.questions));

  if (!PREVIEW_MODE) {
    cleanupStaleAskStates();
    const st = readAskState(askKey);
    if (st) {
      // 同一问题已展示过 / 有存活实例正在展示：不重复弹
      if (st.state === "shown") return;
      if (st.pid && st.pid !== process.pid && pidAlive(st.pid)) return;
    }
    writeAskState(askKey, { state: "pending", pid: process.pid, ts: Date.now() });
  }

  const ps = generateAskDisplayPs({ questions: extracted.questions, sessionId, cwd });
  try {
    executePowerShellScript(ps);
    if (!PREVIEW_MODE) writeAskState(askKey, { state: "shown", pid: process.pid });
  } catch (err) {
    if (!PREVIEW_MODE) removeAskState(askKey);
    logError(`[AskDisplay] Error: ${(err && err.message) || "unknown"}\n`);
  }
}

/**
 * PermissionRequest 路径的 AskUserQuestion 接管：
 * PermissionRequest 钩子在 needsApproval 的 ask 分支触发，早于原生 CLI 面板，
 * payload 带 tool_input（题目+选项）。返回 decision.allow + updatedInput 会被运行时消费——
 * 跳过原生面板、答案直接注入工具输入（与 Claude Code 的 canUseTool 同款机制）。
 */
function handlePermissionRequestForAsk(data) {
  const answers = runAskDialog(data);
  if (!answers) return; // 知道了 / 异常 / 已有答案 → 零输出，退回原生面板
  const toolInput = extractField(data, "tool_input", {});
  const output = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { ...toolInput, answers } },
    },
  };
  if (!PREVIEW_MODE) process.stdout.write(`${JSON.stringify(output)}\n`);
}

// ============================================
// 提醒弹窗（任务完成 / 任务失败 / 等待输入 通用）
// ============================================

/**
 * 生成单按钮提醒弹窗 PS。
 * kind: completed | failed | waiting | info
 */
function generateAlertPs({ title, heading, message, kind, sessionId, cwd, additionalFields = [] }) {
  const S = getStyleHelpers();
  const title_b64 = encodeUtf8ToBase64(title);
  const heading_b64 = encodeUtf8ToBase64(heading);
  const msgLabel_b64 = encodeUtf8ToBase64("最后消息");
  const message_b64 = encodeUtf8ToBase64(message);
  const btnText_b64 = encodeUtf8ToBase64("知道了");

  const accent = kind === "failed" ? S.colors.danger : kind === "waiting" ? S.colors.primary : S.colors.success;

  return `
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore

$w = New-Object System.Windows.Window
$w.Title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${title_b64}'))
$w.Width = 600
$w.Height = ${message ? 460 : 360}
$w.WindowStartupLocation = 'CenterScreen'
$w.ResizeMode = 'NoResize'
$w.Background = '${S.colors.containerBackground}'
$w.Tag = ''

$grid = New-Object System.Windows.Controls.Grid
$grid.Margin = '0'

$row0 = New-Object System.Windows.Controls.RowDefinition; $row0.Height = 'Auto'
$row1 = New-Object System.Windows.Controls.RowDefinition; $row1.Height = 'Auto'
$row2 = New-Object System.Windows.Controls.RowDefinition; $row2.Height = '*'
$row3 = New-Object System.Windows.Controls.RowDefinition; $row3.Height = 'Auto'
$grid.RowDefinitions.Add($row0); $grid.RowDefinitions.Add($row1)
$grid.RowDefinitions.Add($row2); $grid.RowDefinitions.Add($row3)

$titlePanel = New-Object System.Windows.Controls.StackPanel
$titlePanel.Margin = '20,18,20,12'
[System.Windows.Controls.Grid]::SetRow($titlePanel, 0)

$titleText = New-Object System.Windows.Controls.TextBlock
$titleText.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${heading_b64}'))
$titleText.FontSize = ${S.fontSizes.title}
$titleText.FontWeight = 'Bold'
$titleText.Foreground = '${accent}'
$titleText.FontFamily = '${S.fontFamily.text}'
$titleText.HorizontalAlignment = 'Center'
$titlePanel.AddChild($titleText)
$grid.AddChild($titlePanel)

${generateMetaInfoBar(sessionId, cwd, additionalFields)}

${message ? `
$contentFrame = New-Object System.Windows.Controls.Border
$contentFrame.Margin = '16,12,16,12'
$contentFrame.Background = '${S.colors.cardBackground}'
$contentFrame.CornerRadius = '${S.cornerRadius.card}'
$contentFrame.Padding = '16'
${S.cardEffect('contentFrame')}
[System.Windows.Controls.Grid]::SetRow($contentFrame, 2)

$scrollViewer = New-Object System.Windows.Controls.ScrollViewer
$scrollViewer.VerticalScrollBarVisibility = 'Auto'
$scrollViewer.HorizontalScrollBarVisibility = 'Disabled'

$card = New-Object System.Windows.Controls.StackPanel

$msgLbl = New-Object System.Windows.Controls.TextBlock
$msgLbl.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${msgLabel_b64}'))
$msgLbl.FontSize = ${S.fontSizes.content}
$msgLbl.FontWeight = 'Bold'
$msgLbl.Foreground = '${S.colors.labelText}'
$msgLbl.FontFamily = '${S.fontFamily.text}'
$card.AddChild($msgLbl)

$msg = New-Object System.Windows.Controls.TextBlock
$msg.Text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${message_b64}'))
$msg.FontFamily = '${S.fontFamily.mono}'
$msg.FontSize = ${S.fontSizes.message}
$msg.Foreground = '${S.colors.valueText}'
$msg.Margin = '0,4,0,0'
$msg.TextWrapping = 'Wrap'
$card.AddChild($msg)

$scrollViewer.Content = $card
$contentFrame.Child = $scrollViewer
$grid.AddChild($contentFrame)
` : ""}

$btnPanel = New-Object System.Windows.Controls.StackPanel
$btnPanel.HorizontalAlignment = 'Center'
$btnPanel.Margin = '16,12,16,16'
[System.Windows.Controls.Grid]::SetRow($btnPanel, 3)

$btn = New-Object System.Windows.Controls.Button
$btn.Content = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${btnText_b64}'))
$btn.Width = 120
$btn.Height = 36
${S.buttonStyle('btn', 'primary')}
$btn.Add_Click({ $w.Close() })
$btnPanel.AddChild($btn)

$grid.AddChild($btnPanel)

$w.Content = $grid

$w.Add_Loaded({
    $w.Topmost = $true
    $w.Activate()
    $btn.Focus()
    $w.Topmost = $false
})

$w.Add_KeyDown({
    param($sender, $e)
    if ($e.Key -eq 'Escape' -or $e.Key -eq 'Return') { $w.Close() }
})

$w.ShowDialog() | Out-Null
`;
}

function showAlert({ title, heading, message, kind, sound, data, additionalFields = [] }) {
  if (sound) playSound(sound);
  if (kind === "completed") sendHttpNotification(data);

  const cwd = extractField(data, "cwd", "");
  const sessionId = extractField(data, "session_id", "");

  const ps = generateAlertPs({ title, heading, message, kind, sessionId, cwd, additionalFields });
  try {
    executePowerShellScript(ps);
  } catch (err) {
    logError(`[Alert] Error: ${(err && err.message) || "unknown"}\n`);
  }
}

// ============================================
// Stop / StopFailure / Notification 分发
// ============================================

function handleStop(data) {
  const cwd = extractField(data, "cwd", "");
  const sessionId = extractField(data, "session_id", "");
  const permissionMode = data.permission_mode || "";
  const lastMessage = data.last_assistant_message || "";
  const backgroundTasks = (data.background_tasks || []).length;

  const additionalFields = [];
  if (permissionMode) additionalFields.push({ id: "permission", label: "🔐 权限模式", value: permissionMode, wrap: false });
  if (backgroundTasks > 0) additionalFields.push({ id: "tasks", label: "⏳ 后台任务", value: `${backgroundTasks} 个`, wrap: false });

  showAlert({
    title: "Agent Control Center · 任务完成",
    heading: "Agent 已完成，等待输入",
    message: lastMessage ? redactText(lastMessage) : "",
    kind: "completed",
    sound: SOUND_ASTERISK,
    data,
    additionalFields,
  });
}

function handleStopFailure(data) {
  const errorSummary = redactText(String(data.error || data.message || "（无错误详情）"));

  showAlert({
    title: "Agent Control Center · 任务失败",
    heading: "Agent 任务失败",
    message: errorSummary,
    kind: "failed",
    sound: SOUND_EXCLAMATION,
    data,
  });
}

function handleNotification(data) {
  const type = data.notification_type || "";
  if (type === "permission_prompt") {
    const msg = String(data.message || "");
    if (/AskUserQuestion/.test(msg)) {
      // 实测（0.1.7/2.157.0）：AskUserQuestion 面板前唯一钩子是 Notification(permission_prompt)，
      // payload 无题目但带 transcript_path → 反查未作答题目，弹题目展示窗。
      const transcriptPath = extractField(data, "transcript_path", "");
      const extracted = transcriptPath ? extractPendingAskFromTranscript(transcriptPath) : null;
      if (extracted) {
        showAskDisplayPopup(data, extracted);
        return;
      }
      // transcript 反查失败（无文件/已作答/结构变化）→ 回退通用「提问提醒」窗（无题目）
      showAlert({
        title: "Agent Control Center · 提问提醒",
        heading: "Agent 正在向您提问",
        message: "问题已显示在终端，请前往回答。",
        kind: "waiting",
        sound: SOUND_QUESTION,
        data,
      });
      return;
    }
    // ExitPlanMode 等其它权限类通知：仅响铃
    playSound(SOUND_QUESTION);
    return;
  }
  // 注意：不处理 idle_prompt —— 它是「会话空闲 60 秒」定时器触发的（运行时 setTimeout 6e4），
  // 每轮对话结束后用户 60 秒没输入就弹一次，与 Stop 的「已完成，等待输入」弹窗重复且打扰。
  // 只保留真正需要用户响应的场景：elicitation_dialog（MCP 诱导对话框）/ agent_needs_input。
  if (type !== "agent_needs_input" && type !== "elicitation_dialog") return;

  showAlert({
    title: "Agent Control Center · 等待输入",
    heading: "Agent 正在等待您的输入",
    message: "",
    kind: "waiting",
    sound: SOUND_QUESTION,
    data,
  });
}

// ============================================
// 预览模式
// ============================================

function runPreview() {
  const baseData = { session_id: "a1b2c3d4-preview-test", cwd: process.cwd() };

  console.log("[preview] 1/6 PermissionRequest 权限申请弹窗...");
  handlePermissionRequest({
    ...baseData,
    hook_event_name: EVENT_PERMISSION_REQUEST,
    tool_name: "Bash",
    tool_input: { command: "git status --short", description: "预览模拟操作" },
    permission_suggestions: [],
  });

  console.log("[preview] 2/6 AskUserQuestion 单选弹窗...");
  runAskDialog({
    ...baseData,
    hook_event_name: EVENT_PRE_TOOL_USE,
    tool_name: TOOL_ASK_USER_QUESTION,
    tool_input: {
      questions: [{
        header: "预览问题",
        question: "这是一个预览问题，请选择一个选项查看单选弹窗效果：",
        multiSelect: false,
        options: [
          { label: "选项一", description: "第一个选项的描述说明" },
          { label: "选项二", description: "第二个选项的描述说明" },
          { label: "选项三", description: "第三个选项的描述说明" },
        ],
      }],
    },
  });

  console.log("[preview] 3/6 AskUserQuestion 多选弹窗...");
  runAskDialog({
    ...baseData,
    hook_event_name: EVENT_PRE_TOOL_USE,
    tool_name: TOOL_ASK_USER_QUESTION,
    tool_input: {
      questions: [{
        header: "预览多选",
        question: "这是一个多选预览问题，可勾选多个选项：",
        multiSelect: true,
        options: [
          { label: "多选一", description: "第一个多选项" },
          { label: "多选二", description: "第二个多选项" },
        ],
      }],
    },
  });

  console.log("[preview] 4/6 Stop 任务完成弹窗...");
  handleStop({
    ...baseData,
    hook_event_name: EVENT_STOP,
    last_assistant_message: "这是预览的最后一条助手消息，用于展示 Stop 弹窗的消息卡片渲染效果。",
    permission_mode: "default",
    background_tasks: [{ id: "t1" }, { id: "t2" }],
  });

  console.log("[preview] 5/6 StopFailure 任务失败弹窗...");
  handleStopFailure({
    ...baseData,
    hook_event_name: EVENT_STOP_FAILURE,
    error: "预览模拟失败：command not found: not-a-real-cmd",
  });

  console.log("[preview] 6/6 AskUserQuestion 题目展示弹窗（Notification 路径）...");
  showAskDisplayPopup(
    { ...baseData, hook_event_name: EVENT_NOTIFICATION, notification_type: "permission_prompt" },
    {
      callId: "preview-display",
      questions: [{
        header: "部署环境",
        question: "这次要确认的部署/发包，目标环境是哪个？",
        multiSelect: false,
        options: [
          { label: "DEV", description: "开发环境，默认 profile，自动 push 触发，不需要额外开关/建表动作" },
          { label: "SIT", description: "集成测试环境，profile=sit；若开启 tran-api-access 需补配置+建表" },
          { label: "REL", description: "生产环境，profile=rel，需审批+灰度" },
        ],
      }],
    }
  );

  console.log("[preview] 全部弹窗展示完毕");
}

// ============================================
// 主入口
// ============================================

function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

if (PREVIEW_MODE) {
  runPreview();
} else {
  const hookName = process.argv[2] || "";
  const body = readStdinSync();
  let payload = {};
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    payload = {};
  }
  const event = hookName || payload.hook_event_name || "";
  logEvent(event, payload);

  switch (event) {
    case EVENT_PERMISSION_REQUEST:
      handlePermissionRequest(payload);
      break;
    case EVENT_PRE_TOOL_USE:
      // PreToolUse 拦截已退役（AskUserQuestion 场景必然迟到，见 hooks.json / PermissionRequest 接管）
      break;
      break;
    case EVENT_STOP:
      // 仅自然结束（非 stop hook 打断）才弹「任务完成」
      if (!payload.stop_hook_active) handleStop(payload);
      break;
    case "TaskCompleted":
      // 静默：TaskCompleted 只在任务/待办系统里某个 todo 被标 completed 时触发，
      // 多步骤任务每一步都会触发，与 Stop 的「任务完成」弹窗重复。完成信号统一由 Stop 承载。
      break;
    case EVENT_STOP_FAILURE:
      handleStopFailure(payload);
      break;
    case EVENT_NOTIFICATION:
      handleNotification(payload);
      break;
    default:
      break;
  }
}

process.exit(0);
