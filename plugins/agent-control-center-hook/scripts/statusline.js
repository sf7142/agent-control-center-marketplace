#!/usr/bin/env node
// agent-control-center 插件提供的 statusline (JS 版)
// 显示：插件标识 | 模型 | git 分支 | 上下文使用率渐变进度条 | 工作目录 | 时间
const { execSync } = require("child_process");
const path = require("path");
const os = require("os");

// ===== ANSI 颜色与样式 =====
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  // 前景色（256 色）
  fg: (n) => `\x1b[38;5;${n}m`,
  // 真彩色（24-bit RGB）
  rgb: (r, g, b) => `\x1b[38;2;${r};${g};${b}m`,
};

// ===== 读取 stdin =====
function readStdin() {
  try {
    return require("fs").readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// ===== 解析 JSON（容错） =====
function parseInput(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ===== 获取 git 分支 =====
function getBranch(cwd) {
  if (!cwd) return "";
  try {
    return execSync("git --no-optional-locks symbolic-ref --short HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

// ===== 获取 git 工作区状态（脏/干净） =====
function getGitDirty(cwd) {
  if (!cwd) return null;
  try {
    const out = execSync("git --no-optional-locks status --porcelain", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return out.trim().length > 0;
  } catch {
    return null;
  }
}

// ===== 渐变颜色：根据百分比从青→黄→红 =====
function gradientColor(pct) {
  // 0%   -> 青 (0, 255, 200)
  // 50%  -> 黄 (255, 220, 0)
  // 100% -> 红 (255, 60, 60)
  const p = Math.max(0, Math.min(100, pct));
  let r, g, b;
  if (p < 50) {
    const t = p / 50;
    r = Math.round(0 + (255 - 0) * t);
    g = Math.round(255 + (220 - 255) * t);
    b = Math.round(200 + (0 - 200) * t);
  } else {
    const t = (p - 50) / 50;
    r = Math.round(255 + (255 - 255) * t);
    g = Math.round(220 + (60 - 220) * t);
    b = Math.round(0 + (60 - 0) * t);
  }
  return C.rgb(r, g, b);
}

// ===== 构建渐变进度条 =====
function buildBar(pct, width = 12) {
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  const empty = width - filled;

  let bar = "";
  // 填充段：每格按其位置取渐变色
  for (let i = 0; i < filled; i++) {
    const cellPct = ((i + 1) / width) * 100;
    bar += gradientColor(cellPct) + "█";
  }
  // 空白段：暗灰
  bar += C.fg(238);
  for (let i = 0; i < empty; i++) bar += "░";
  bar += C.reset;
  return bar;
}

// ===== 缩短路径（home -> ~，超长截断） =====
function shortenPath(p) {
  if (!p) return "";
  let s = p.replace(/\\/g, "/");
  const home = (os.homedir() || "").replace(/\\/g, "/");
  if (home && s.toLowerCase().startsWith(home.toLowerCase())) {
    s = "~" + s.slice(home.length);
  }
  // 超过 3 段时只保留最后 3 段
  const parts = s.split("/").filter(Boolean);
  if (parts.length > 3) {
    const prefix = s.startsWith("/") ? "/" : "";
    s = prefix + "…/" + parts.slice(-3).join("/");
  }
  return s;
}

// ===== 把可能的 Windows 路径转为 unix 风（git 命令用） =====
function toUnixPath(p) {
  if (!p) return p;
  try {
    return execSync(`cygpath -u "${p}"`, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return p;
  }
}

// ===== 主流程 =====
const raw = readStdin();
const input = parseInput(raw);

const model =
  input?.model?.display_name ||
  input?.display_name ||
  input?.model ||
  "Unknown";

const usedRaw =
  input?.context_window?.used_percentage ??
  input?.context?.used_percentage ??
  input?.used_percentage ??
  input?.usage?.used_percentage;
const used = typeof usedRaw === "number" ? usedRaw : parseFloat(usedRaw);

const cwdRaw =
  input?.workspace?.current_dir ||
  input?.current_dir ||
  input?.cwd ||
  process.cwd();
const cwdUnix = toUnixPath(cwdRaw);

const branch = getBranch(cwdUnix);
const dirty = branch ? getGitDirty(cwdUnix) : null;

// ===== 组装各段 =====
// 1. 插件标识：渐变紫蓝
const brand = `${C.bold}${C.rgb(140, 100, 255)}⚡${C.rgb(100, 180, 255)}acc${C.reset}`;

// 2. 模型：青色加粗
const modelSeg = `${C.bold}${C.rgb(120, 230, 220)}${model}${C.reset}`;

// 3. 分支：紫色 + 脏标记
let branchSeg = "";
if (branch) {
  const dirtyMark = dirty
    ? `${C.rgb(255, 180, 80)}●${C.reset}`
    : `${C.rgb(120, 230, 140)}✓${C.reset}`;
  branchSeg = `${C.rgb(200, 140, 255)} ${branch}${C.reset} ${dirtyMark}`;
}

// 4. 进度条：渐变 + 数值
let ctxSeg;
if (!isNaN(used)) {
  const bar = buildBar(used, 12);
  const pct = Math.round(used);
  const pctColor = gradientColor(used);
  ctxSeg = `${bar} ${pctColor}${C.bold}${String(pct).padStart(3)}%${C.reset}`;
} else {
  ctxSeg = `${C.fg(238)}[░░░░░░░░░░░░]${C.reset} ${C.dim}--%${C.reset}`;
}

// 5. 工作目录：灰色
const dirSeg = `${C.fg(245)}${shortenPath(cwdRaw)}${C.reset}`;

// 6. 时间：暗色
const now = new Date();
const hh = String(now.getHours()).padStart(2, "0");
const mm = String(now.getMinutes()).padStart(2, "0");
const timeSeg = `${C.dim}${hh}:${mm}${C.reset}`;

// ===== 分隔符 =====
const sep = `${C.fg(240)} │ ${C.reset}`;

// ===== 最终输出 =====
const segments = [brand, modelSeg];
if (branchSeg) segments.push(branchSeg);
segments.push(ctxSeg, dirSeg, timeSeg);

process.stdout.write(segments.join(sep));
