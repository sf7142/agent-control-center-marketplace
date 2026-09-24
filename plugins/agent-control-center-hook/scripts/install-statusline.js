#!/usr/bin/env node
"use strict";

/**
 * install-statusline.js — 在 SessionStart 时把 statusLine 写入 ~/.codebuddy/settings.json。
 *
 * 为什么不用安装脚本写死绝对路径：发布成 marketplace 后，插件会被装到每个用户自己的目录，
 * 绝对路径会失效。这里通过 ${CODEBUDDY_PLUGIN_ROOT}（CodeBuddy 注入的环境变量）在运行时
 * 解析出插件的真实安装目录，动态写 statusLine。
 *
 * 设计原则（借鉴 absf-base）：
 *   - 幂等：命令路径相同则跳过，不反复写
 *   - 不覆盖：用户已配置了非本插件的 statusLine（无 _accBase 标记）时保留不动
 *   - 可识别：_accBase 标记标识是本插件写入的
 *   - 静默：除非有变化，否则不输出（SessionStart 的 stdout 会作为上下文注入）
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MARKER = "_accBase";

const pluginRoot = process.env.CODEBUDDY_PLUGIN_ROOT;
if (!pluginRoot) {
  // 非插件上下文调用，静默退出
  process.exit(0);
}

const statuslineScript = path.join(pluginRoot, "scripts", "statusline.js").replace(/\\/g, "/");
const settingsPath = path.join(os.homedir(), ".codebuddy", "settings.json");

let settings = {};
try {
  const raw = fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
  if (raw.trim()) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed;
    }
  }
} catch (err) {
  if (err && err.code !== "ENOENT") {
    // settings.json 存在但解析不了：绝不覆盖用户配置
    process.exit(0);
  }
}

const desired = { command: `node "${statuslineScript}"`, padding: 0, [MARKER]: true };
const existing = settings.statusLine;
const isOurs = Boolean(existing && typeof existing === "object" && existing[MARKER] === true);

if (existing && !isOurs) {
  // 用户/其他插件已配置 statusLine，绝不覆盖
  process.exit(0);
}

const same = isOurs && existing.command === desired.command && existing.padding === desired.padding;
if (same) {
  process.exit(0);
}

settings.statusLine = desired;
try {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
} catch {
  // 写失败静默退出
}

process.exit(0);
