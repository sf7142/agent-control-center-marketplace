#!/usr/bin/env node
"use strict";

/**
 * install.js — 离线安装器（无需网络、无需 npm、无需 clone）。
 *
 * 把本市场注册到 ~/.codebuddy/settings.json：
 *   - extraKnownMarketplaces["agent-control-center"] → 目录源指向本市场目录
 *   - enabledPlugins["agent-control-center-hook@agent-control-center"] = true
 *
 * 用法：在解压后的市场根目录运行  node install.js  （或双击 install.bat）
 *
 * 注意：解压后的目录需要保留（CodeBuddy 的目录市场会引用这个源路径），不要安装完就删。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MARKETPLACE_NAME = "agent-control-center";
const PLUGIN_ID = "agent-control-center-hook@agent-control-center";
const marketplaceDir = __dirname;

// 校验市场清单存在
const manifestPath = path.join(marketplaceDir, ".codebuddy-plugin", "marketplace.json");
if (!fs.existsSync(manifestPath)) {
  console.error("[错误] 找不到 .codebuddy-plugin/marketplace.json，请确认在完整解压后的市场根目录运行。");
  process.exit(1);
}

const settingsPath = path.join(os.homedir(), ".codebuddy", "settings.json");

let settings = {};
try {
  const raw = fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
  if (raw.trim()) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error("[错误] settings.json 不是合法对象，已中止（不覆盖你的配置）。");
      process.exit(1);
    }
    settings = parsed;
  }
} catch (err) {
  if (err && err.code !== "ENOENT") {
    console.error(`[错误] settings.json 解析失败，已中止：${err.message}`);
    process.exit(1);
  }
  // 文件不存在 → 用空配置继续
}

const marketplaces = { ...((settings.extraKnownMarketplaces && typeof settings.extraKnownMarketplaces === "object") ? settings.extraKnownMarketplaces : {}) };
marketplaces[MARKETPLACE_NAME] = { source: { source: "directory", path: marketplaceDir.replace(/\\/g, "/") } };

const enabled = { ...((settings.enabledPlugins && typeof settings.enabledPlugins === "object") ? settings.enabledPlugins : {}) };
enabled[PLUGIN_ID] = true;

const next = { ...settings, extraKnownMarketplaces: marketplaces, enabledPlugins: enabled };

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

console.log("安装完成：");
console.log(`  市场  : ${marketplaceDir}`);
console.log(`  插件  : ${PLUGIN_ID}`);
console.log("请重启 CodeBuddy Code，或在会话里运行 /reload-plugins 生效。");
