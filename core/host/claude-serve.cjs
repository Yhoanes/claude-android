#!/usr/bin/env node
"use strict";

/**
 * claude-serve.cjs — Standalone Agentic Host Server for Claude Code Android (v2.1.325)
 *
 * Runs Anthropic's official `extension.js` + Full-Editor React UI (`webview/index.js`)
 * over a local loopback HTTP + RFC-6455 WebSocket + native PTY server (`127.0.0.1:45177`).
 */

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const Module = require("module");
const { URL } = require("url");
const { spawn } = require("child_process");
const { createVSCodeShim } = require("./vscode-shim.cjs");

// -----------------------------------------------------------------------------
// CLI Args & Paths
// -----------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    host: "127.0.0.1",
    port: Number(process.env.CC_PORT || 45177),
    workspace: process.env.CC_DEFAULT_WORKSPACE || "",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--port" || a === "-p") && argv[i + 1]) out.port = Number(argv[++i]);
    else if ((a === "--hostname" || a === "--host") && argv[i + 1]) out.host = argv[++i];
    else if ((a === "--workspace" || a === "-w") && argv[i + 1]) out.workspace = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);

// Loopback is shared by every app on Android: every request must carry the per-boot
// token minted by the Android service (cookie for the WebView, header for native probes).
const HOST_TOKEN = String(process.env.CC_HOST_TOKEN || "").trim() || crypto.randomBytes(24).toString("hex");
delete process.env.CC_HOST_TOKEN;
const HOST_TOKEN_BUF = Buffer.from(HOST_TOKEN, "utf8");

// API key: Android decrypts it from the Keystore and hands it over in memory only.
// When CC_SECRET_STORE=1 the key must never be written to any file on disk.
const SECRET_STORE_ACTIVE = process.env.CC_SECRET_STORE === "1";
const SECRET_ENV_NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
let secretApiKey = String(process.env.CC_SECRET_API_KEY || "").trim();
delete process.env.CC_SECRET_STORE;
delete process.env.CC_SECRET_API_KEY;

// Voice dictation: the official extension records with `arecord` (16 kHz mono S16_LE on
// stdout). Our runtime/bin/arecord asks the Android app for microphone audio, and Android
// only answers with this per-boot token. Only the extension's own arecord gets it, so a
// command Claude runs in its terminal cannot record the microphone.
const MIC_TOKEN = String(process.env.CC_MIC_TOKEN || "");
delete process.env.CC_MIC_TOKEN;
if (MIC_TOKEN) {
  const childProcess = require("child_process");
  const origSpawn = childProcess.spawn;
  childProcess.spawn = function spawnWithMicToken(command, spawnArgs, options) {
    if (typeof command === "string" && path.basename(command) === "arecord") {
      if (!Array.isArray(spawnArgs)) {
        options = spawnArgs;
        spawnArgs = [];
      }
      const baseEnv = (options && options.env) || process.env;
      return origSpawn.call(this, command, spawnArgs, { ...(options || {}), env: { ...baseEnv, CC_MIC_TOKEN: MIC_TOKEN } });
    }
    return origSpawn.apply(this, arguments);
  };
}

function tokenMatches(candidate) {
  if (typeof candidate !== "string" || !candidate) return false;
  const buf = Buffer.from(candidate, "utf8");
  return buf.length === HOST_TOKEN_BUF.length && crypto.timingSafeEqual(buf, HOST_TOKEN_BUF);
}

function isAuthorizedRequest(req) {
  const allowedHosts = [`127.0.0.1:${args.port}`, `localhost:${args.port}`];
  const host = String(req.headers.host || "").toLowerCase();
  if (!allowedHosts.includes(host)) return false;
  const origin = req.headers.origin;
  if (origin && !allowedHosts.some((h) => origin === `http://${h}`)) return false;
  if (tokenMatches(req.headers["x-cc-host-token"])) return true;
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)cc_host_token=([^;]+)/);
  if (!m) return false;
  try {
    return tokenMatches(decodeURIComponent(m[1]));
  } catch (_) {
    return false;
  }
}

const HOME_DIR = process.env.HOME || os.homedir();
const EXTENSION_DIR = __dirname;
const CLAUDE_DIR = path.join(HOME_DIR, ".claude");
const HOST_STORAGE_DIR = path.join(CLAUDE_DIR, "android-host");
// The official engine keeps trust, approvals and known projects in
// join(CLAUDE_CONFIG_DIR || homedir(), ".claude.json"). Android sets CLAUDE_CONFIG_DIR=~/.claude.
const CLAUDE_GLOBAL_CONFIG = path.join(process.env.CLAUDE_CONFIG_DIR || HOME_DIR, ".claude.json");
// Older builds wrote ~/.claude.json, a file the engine never reads (trust never applied).
const LEGACY_WRONG_CONFIG = path.join(HOME_DIR, ".claude.json");
// Created by the app itself, so it is safe to trust without asking.
const APP_DEFAULT_WORKSPACE = "/storage/emulated/0/Documents/ClaudeCode";
const WORKSPACE_STATE_FILE = path.join(HOST_STORAGE_DIR, "last-workspace.json");
const HIDDEN_WORKSPACES_FILE = path.join(HOST_STORAGE_DIR, "hidden-workspaces.json");
const SESSION_FILE_RENAMES_FILE = path.join(HOST_STORAGE_DIR, "session-file-renames.json");

function canonicalizeAndroidPath(p) {
  const raw = String(p || "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  const expanded = raw.replace(/^\/sdcard(?=\/|$)/, "/storage/emulated/0");
  return path.resolve(expanded);
}

function readHiddenWorkspaces() {
  try {
    if (fs.existsSync(HIDDEN_WORKSPACES_FILE)) {
      const arr = JSON.parse(fs.readFileSync(HIDDEN_WORKSPACES_FILE, "utf8"));
      if (Array.isArray(arr)) return new Set(arr.map(canonicalizeAndroidPath).filter(Boolean));
    }
  } catch (_) {}
  return new Set();
}

function writeHiddenWorkspaces(setObj) {
  try {
    fs.mkdirSync(HOST_STORAGE_DIR, { recursive: true });
    fs.writeFileSync(HIDDEN_WORKSPACES_FILE, JSON.stringify(Array.from(setObj), null, 2), { mode: 0o600 });
  } catch (_) {}
}

function hasActiveCredentialsAtBoot() {
  if (secretApiKey) return true;
  if (fs.existsSync(path.join(CLAUDE_DIR, ".credentials.json"))) return true;
  try {
    const settingsPath = path.join(CLAUDE_DIR, "settings.json");
    if (fs.existsSync(settingsPath)) {
      const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (cfg?.env?.ANTHROPIC_API_KEY || cfg?.env?.ANTHROPIC_AUTH_TOKEN) return true;
    }
  } catch (_) {}
  return false;
}

function resolveInitialWorkspace() {
  if (hasActiveCredentialsAtBoot()) {
    try {
      if (fs.existsSync(WORKSPACE_STATE_FILE)) {
        const saved = JSON.parse(fs.readFileSync(WORKSPACE_STATE_FILE, "utf8"));
        if (saved && saved.workspace) {
          const cand = canonicalizeAndroidPath(saved.workspace);
          if (cand && fs.existsSync(cand)) return cand;
        }
      }
    } catch (_) {}
    if (args.workspace && fs.existsSync(args.workspace)) return canonicalizeAndroidPath(args.workspace);
  }
  const sdcardDefault = APP_DEFAULT_WORKSPACE;
  try {
    fs.mkdirSync(sdcardDefault, { recursive: true });
    ensureWorkspaceTrustedInClaudeJson(sdcardDefault);
    return sdcardDefault;
  } catch (_) {}
  const localDefault = path.join(HOME_DIR, "workspace");
  fs.mkdirSync(localDefault, { recursive: true });
  ensureWorkspaceTrustedInClaudeJson(localDefault);
  return localDefault;
}

function saveLastWorkspace(ws) {
  const canon = canonicalizeAndroidPath(ws) || ws;
  try {
    fs.mkdirSync(HOST_STORAGE_DIR, { recursive: true });
    fs.writeFileSync(WORKSPACE_STATE_FILE, JSON.stringify({ workspace: canon }, null, 2), { mode: 0o600 });
    const hidden = readHiddenWorkspaces();
    if (hidden.delete(canon)) writeHiddenWorkspaces(hidden);
  } catch (_) {}
  // Other folders get the official "Trust this folder?" question when first opened.
  if (canon === APP_DEFAULT_WORKSPACE) ensureWorkspaceTrustedInClaudeJson(canon);
}

function ensureWorkspaceTrustedInClaudeJson(ws) {
  if (!ws) return;
  const claudeJsonPath = CLAUDE_GLOBAL_CONFIG;
  let cj = {};
  try {
    if (fs.existsSync(claudeJsonPath)) {
      cj = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
    }
  } catch (_) {}
  if (!cj || typeof cj !== "object") cj = {};
  if (!cj.projects || typeof cj.projects !== "object") cj.projects = {};

  const pathsToTrust = new Set([path.resolve(ws)]);
  try { pathsToTrust.add(fs.realpathSync(ws)); } catch (_) {}

  let changed = false;
  for (const p of pathsToTrust) {
    if (!cj.projects[p] || typeof cj.projects[p] !== "object") {
      cj.projects[p] = { hasTrustDialogAccepted: true };
      changed = true;
    } else if (cj.projects[p].hasTrustDialogAccepted !== true) {
      cj.projects[p].hasTrustDialogAccepted = true;
      changed = true;
    }
  }
  if (changed) {
    try {
      const tmp = claudeJsonPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(cj, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, claudeJsonPath);
    } catch (_) {}
  }
}

function scrubPrimaryApiKeyFromConfigJson(configJsonPath) {
  try {
    if (fs.existsSync(configJsonPath)) {
      const cfgJ = JSON.parse(fs.readFileSync(configJsonPath, "utf8")) || {};
      if (Object.prototype.hasOwnProperty.call(cfgJ, "primaryApiKey")) {
        delete cfgJ.primaryApiKey;
        fs.writeFileSync(configJsonPath, JSON.stringify(cfgJ, null, 2) + "\n", { mode: 0o600 });
      }
    }
  } catch (_) {}
}

function syncApiKeyApprovalInClaudeJson(apiKey, setAsPrimary) {
  const claudeJsonPath = CLAUDE_GLOBAL_CONFIG;
  const configJsonPath = path.join(CLAUDE_DIR, "config.json");
  // With the Keystore active the key reaches Claude via the environment only.
  if (SECRET_STORE_ACTIVE) setAsPrimary = false;
  let cj = {};
  try {
    if (fs.existsSync(claudeJsonPath)) cj = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
  } catch (_) {}
  if (!cj || typeof cj !== "object") cj = {};

  if (!apiKey) {
    delete cj.primaryApiKey;
    scrubPrimaryApiKeyFromConfigJson(configJsonPath);
  } else {
    const cleanKey = String(apiKey).trim();
    const suffix20 = cleanKey.slice(-20);
    if (!cj.customApiKeyResponses || typeof cj.customApiKeyResponses !== "object") {
      cj.customApiKeyResponses = { approved: [], rejected: [] };
    }
    const approved = Array.isArray(cj.customApiKeyResponses.approved) ? cj.customApiKeyResponses.approved : [];
    const rejected = (Array.isArray(cj.customApiKeyResponses.rejected) ? cj.customApiKeyResponses.rejected : [])
      .filter((x) => x !== suffix20);
    if (suffix20 && !approved.includes(suffix20)) {
      approved.push(suffix20);
    }
    cj.customApiKeyResponses = { approved, rejected };
    if (setAsPrimary && /^[a-zA-Z0-9-_]+$/.test(cleanKey)) {
      cj.primaryApiKey = cleanKey;
      try {
        fs.mkdirSync(CLAUDE_DIR, { recursive: true });
        let cfgJ = {};
        if (fs.existsSync(configJsonPath)) cfgJ = JSON.parse(fs.readFileSync(configJsonPath, "utf8")) || {};
        cfgJ.primaryApiKey = cleanKey;
        fs.writeFileSync(configJsonPath, JSON.stringify(cfgJ, null, 2) + "\n", { mode: 0o600 });
      } catch (_) {}
    } else {
      delete cj.primaryApiKey;
      scrubPrimaryApiKeyFromConfigJson(configJsonPath);
    }
  }

  try {
    const tmp = claudeJsonPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cj, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, claudeJsonPath);
  } catch (_) {}
}

function applyApiKeyToProcessEnv(apiKey, useBearer) {
  if (!apiKey) {
    for (const n of SECRET_ENV_NAMES) delete process.env[n];
    syncApiKeyApprovalInClaudeJson(null, false);
    return;
  }
  process.env.ANTHROPIC_API_KEY = apiKey;
  if (useBearer) process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
  else delete process.env.ANTHROPIC_AUTH_TOKEN;
  syncApiKeyApprovalInClaudeJson(apiKey, !useBearer);
}

// -----------------------------------------------------------------------------
// Seed ~/.claude/settings.json (sandbox disabled on Android) & Official Skills
// -----------------------------------------------------------------------------
function ensureAndroidClaudeSettings() {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  const settingsPath = path.join(CLAUDE_DIR, "settings.json");
  let cfg = {};
  try {
    if (fs.existsSync(settingsPath)) {
      cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    }
  } catch (_) {}
  if (!cfg || typeof cfg !== "object") cfg = {};
  if (!cfg.sandbox || typeof cfg.sandbox !== "object") cfg.sandbox = {};
  if (cfg.sandbox.enabled !== false) {
    cfg.sandbox.enabled = false;
  }
  if (!cfg.env || typeof cfg.env !== "object") cfg.env = {};
  if (SECRET_STORE_ACTIVE) {
    // Android already captured any legacy plaintext key into the Keystore: scrub it.
    for (const n of SECRET_ENV_NAMES) delete cfg.env[n];
  } else if (!secretApiKey) {
    secretApiKey = String(cfg.env.ANTHROPIC_API_KEY || cfg.env.ANTHROPIC_AUTH_TOKEN || "").trim();
  }
  const credsFile = path.join(CLAUDE_DIR, ".credentials.json");
  const hasOAuth = fs.existsSync(credsFile);
  for (const [k, v] of Object.entries(cfg.env)) {
    if (SECRET_ENV_NAMES.includes(k)) continue;
    if (hasOAuth && k === "ANTHROPIC_BASE_URL") continue;
    if (typeof v === "string" && v.length > 0) {
      process.env[k] = v;
    }
  }
  if (secretApiKey && !hasOAuth) {
    applyApiKeyToProcessEnv(secretApiKey, Boolean(cfg.env.ANTHROPIC_BASE_URL));
  } else if (SECRET_STORE_ACTIVE) {
    syncApiKeyApprovalInClaudeJson(null, false);
  }
  try {
    const tmp = settingsPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, settingsPath);
  } catch (_) {}

  // Ensure bundled official Anthropic skills exist in ~/.claude/skills/
  const bundledSkillsCandidates = [
    path.resolve(EXTENSION_DIR, "..", "bundled-skills"),
    path.join(HOME_DIR, "runtime", "bundled-skills"),
  ];
  const userSkillsDir = path.join(CLAUDE_DIR, "skills");
  for (const srcRoot of bundledSkillsCandidates) {
    if (!fs.existsSync(srcRoot)) continue;
    try {
      fs.mkdirSync(userSkillsDir, { recursive: true });
      for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dst = path.join(userSkillsDir, entry.name);
        if (!fs.existsSync(dst)) {
          fs.cpSync(path.join(srcRoot, entry.name), dst, { recursive: true });
        }
      }
    } catch (_) {}
    break;
  }
}

function resolveClaudeBinaryPath() {
  const candidates = [
    process.env.CC_CLAUDE_BIN,
    path.join(EXTENSION_DIR, "resources", "native-binary", "claude"),
    path.resolve(EXTENSION_DIR, "..", "bin", "claude"),
    path.join(HOME_DIR, "runtime", "bin", "claude"),
    path.join(HOME_DIR, "usr", "bin", "claude"),
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        fs.chmodSync(c, 0o755);
        return c;
      }
    } catch (_) {}
  }
  return candidates[1];
}

ensureAndroidClaudeSettings();
try { if (LEGACY_WRONG_CONFIG !== CLAUDE_GLOBAL_CONFIG) fs.rmSync(LEGACY_WRONG_CONFIG, { force: true }); } catch (_) {}
ensureWorkspaceTrustedInClaudeJson(APP_DEFAULT_WORKSPACE);
const initialWorkspace = resolveInitialWorkspace();
saveLastWorkspace(initialWorkspace);
try { process.chdir(initialWorkspace); } catch (_) {}

const claudeBinaryPath = resolveClaudeBinaryPath();
// Ensure extension.js also finds resources/native-binary/claude directly
try {
  const extBinDir = path.join(EXTENSION_DIR, "resources", "native-binary");
  const extBinFile = path.join(extBinDir, "claude");
  fs.mkdirSync(extBinDir, { recursive: true });
  if (!fs.existsSync(extBinFile) && claudeBinaryPath && fs.existsSync(claudeBinaryPath) && path.resolve(claudeBinaryPath) !== path.resolve(extBinFile)) {
    try {
      fs.symlinkSync(claudeBinaryPath, extBinFile);
    } catch (_) {
      fs.writeFileSync(extBinFile, `#!/system/bin/sh\nexec "${claudeBinaryPath}" "$@"\n`, { mode: 0o755 });
    }
  }
} catch (_) {}

// -----------------------------------------------------------------------------
// RFC-6455 Pure Node.js WebSocket Framing
// -----------------------------------------------------------------------------
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptWebSocket(req, socket, onMessage, onClose) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  let closed = false;
  let buffer = Buffer.alloc(0);
  let fragOpcode = 0;
  let fragChunks = [];

  function sendFrame(opcode, payloadBuf) {
    if (closed || socket.destroyed) return;
    const len = payloadBuf.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      socket.write(Buffer.concat([header, payloadBuf]));
    } catch (_) {}
  }

  const wsConn = {
    sendText(str) {
      sendFrame(0x01, Buffer.from(String(str), "utf8"));
    },
    sendJson(obj) {
      sendFrame(0x01, Buffer.from(JSON.stringify(obj), "utf8"));
    },
    close() {
      if (closed) return;
      closed = true;
      try { sendFrame(0x08, Buffer.alloc(0)); } catch (_) {}
      try { socket.end(); } catch (_) {}
    },
  };

  const MAX_WS_BUFFER_BYTES = 64 * 1024 * 1024;
  socket.on("data", (chunk) => {
    if (buffer.length + chunk.length > MAX_WS_BUFFER_BYTES) {
      wsConn.close();
      socket.destroy();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskBytes = masked ? 4 : 0;
      if (buffer.length < offset + maskBytes + payloadLen) return;

      let payload = buffer.subarray(offset + maskBytes, offset + maskBytes + payloadLen);
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ mask[i & 3];
        }
        payload = unmasked;
      }
      buffer = buffer.subarray(offset + maskBytes + payloadLen);

      if (opcode === 0x08) {
        wsConn.close();
        return;
      } else if (opcode === 0x09) {
        sendFrame(0x0a, payload);
      } else if (opcode === 0x0a) {
        // pong
      } else if (opcode === 0x01 || opcode === 0x02) {
        if (fin) {
          onMessage(payload, opcode === 0x02);
        } else {
          fragOpcode = opcode;
          fragChunks = [payload];
        }
      } else if (opcode === 0x00 && fragChunks.length > 0) {
        fragChunks.push(payload);
        let fragTotal = 0;
        for (let k = 0; k < fragChunks.length; k++) fragTotal += fragChunks[k].length;
        if (fragTotal > MAX_WS_BUFFER_BYTES) {
          fragChunks = [];
          wsConn.close();
          socket.destroy();
          return;
        }
        if (fin) {
          const full = Buffer.concat(fragChunks);
          const isBin = fragOpcode === 0x02;
          fragChunks = [];
          fragOpcode = 0;
          onMessage(full, isBin);
        }
      }
    }
  });

  const finishClose = () => {
    if (closed) return;
    closed = true;
    if (onClose) onClose(wsConn);
  };
  socket.on("close", finishClose);
  socket.on("error", finishClose);

  return wsConn;
}

// -----------------------------------------------------------------------------
// Wire VSCode Shim + Activate Official Anthropic extension.js
// -----------------------------------------------------------------------------
const uiClients = new Set(); // { ws, panelId }

function broadcastHostEvent(eventType, payload = {}) {
  const frame = { __cc_host_event: eventType, ...payload };
  for (const c of uiClients) {
    c.ws.sendJson(frame);
  }
}

function broadcastPanelList() {
  const list = Array.from(shim.getPanels().values()).map((p) => ({
    id: p.id,
    title: p.title,
    active: p.active,
  }));
  broadcastHostEvent("panels_updated", { panels: list });
}

const workspacePanels = new Map();
const GENERAL_SETTING_KEYS = [
  "claudeCode.initialPermissionMode",
  "claudeCode.allowDangerouslySkipPermissions",
  "claudeCode.focusView",
  "claudeCode.promptSuggestions",
  "claudeCode.pinPrompt",
  "claudeCode.useCtrlEnterToSend",
  "claudeCode.showMessageTimestamps",
  "claudeCode.scrollToBottomOnSend",
  "claudeCode.respectGitIgnore",
  "claudeCode.continueAfterReload",
  "claudeCode.hideOnboarding",
  "claudeCode.archiveInactiveSessions",
];
const pendingPrompts = new Map(); // promptId -> { payload, resolve, timer }
let promptSeq = 0;

function escapeHtmlAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getOptimisticWebviewAuthStatus() {
  const auth = readAuthConfigSummary();
  if (auth.activeMode === "oauth") {
    return { authMethod: "claudeai", email: null, subscriptionType: null };
  }
  if (auth.activeMode === "apikey") {
    return { authMethod: "api-key", email: null, subscriptionType: null };
  }
  return null;
}

function applyPanelStateOverrides(st, optimisticAuth) {
  if (!st || typeof st !== "object") return;
  st.openNewInTab = false;
  if (optimisticAuth && (st.authStatus === null || (st.authStatus === undefined && !st.authStatusPending))) {
    st.authStatus = optimisticAuth;
  }
}

const shim = createVSCodeShim({
  port: args.port,
  extensionPath: EXTENSION_DIR,
  storageDir: HOST_STORAGE_DIR,
  initialWorkspace,
  claudeBinaryPath,
  log: (...a) => console.log(...a),
  onPanelCreated() {
    setImmediate(broadcastPanelList);
  },
  onPanelDisposed(panelId) {
    for (const [wsKey, pId] of workspacePanels.entries()) {
      if (pId === panelId) workspacePanels.delete(wsKey);
    }
    broadcastHostEvent("panel_disposed", { panelId });
    setImmediate(broadcastPanelList);
  },
  onPanelMessage(panelId, message) {
    if (message && typeof message === "object") {
      const optimisticAuth = getOptimisticWebviewAuthStatus();
      const inner = (message.type === "from-extension" && message.message && typeof message.message === "object")
        ? message.message
        : message;
      if (inner.response && inner.response.state) {
        applyPanelStateOverrides(inner.response.state, optimisticAuth);
      }
      if (inner.request && inner.request.state) {
        applyPanelStateOverrides(inner.request.state, optimisticAuth);
      }
      if (inner.state) {
        applyPanelStateOverrides(inner.state, optimisticAuth);
      }
    }
    for (const c of uiClients) {
      if (!c.panelId || c.panelId === panelId) {
        c.ws.sendJson({ __cc_panel_msg: true, panelId, message });
      }
    }
  },
  onOpenExternal(urlStr) {
    if (uiClients.size > 0) {
      broadcastHostEvent("open_external", { url: urlStr });
      return true;
    }
    return false;
  },
  onShowMessage(level, text) {
    broadcastHostEvent("toast", { level, text: String(text || "") });
  },
  onOpenPreview(previewPayload) {
    broadcastHostEvent("open_preview", previewPayload);
  },
  onOpenSettings(query) {
    broadcastHostEvent("open_settings", { query: String(query || "") });
  },
  onUserPrompt(payload) {
    // Never show "Trust this folder in Claude Code?" over the pre-login screen
    if (
      payload &&
      typeof payload.message === "string" &&
      payload.message.includes("Trust this folder") &&
      readAuthConfigSummary().activeMode === "none"
    ) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const promptId = "pr_" + (++promptSeq) + "_" + Date.now().toString(36);
      // Modal questions (trust, quick picks) wait for the user; plain notifications expire.
      const ttlMs = payload && payload.modal ? 15 * 60 * 1000 : 90 * 1000;
      const timer = setTimeout(() => settleUserPrompt(promptId, undefined), ttlMs);
      pendingPrompts.set(promptId, { payload, resolve, timer });
      broadcastHostEvent("user_prompt", { promptId, ...payload });
    });
  },
});

function settleUserPrompt(promptId, value) {
  const entry = pendingPrompts.get(promptId);
  if (!entry) return false;
  pendingPrompts.delete(promptId);
  clearTimeout(entry.timer);
  try { entry.resolve(value); } catch (_) {}
  broadcastHostEvent("user_prompt_closed", { promptId });
  return true;
}

const origMapSet = Map.prototype.set;
Map.prototype.set = function patchedMapSet(k, v) {
  if (
    k && typeof k === "object" && k.webview &&
    v && typeof v === "object" && typeof v.cwd === "string" && typeof v.pushStateUpdate === "function"
  ) {
    k._claudeComms = v;
  }
  return origMapSet.call(this, k, v);
};

const origLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return shim.vscodeApi;
  }
  return origLoad.apply(this, arguments);
};

let extensionActivated = false;
let activationError = null;

async function bootExtensionHost() {
  try {
    const extModule = require(path.join(EXTENSION_DIR, "extension.js"));
    const ctx = shim.createExtensionContext();
    await Promise.resolve(extModule.activate(ctx));
    extensionActivated = true;
    await shim.vscodeApi.commands.executeCommand("claude-vscode.primaryEditor.open");
    const initPanel = shim.getActivePanel();
    if (initPanel) {
      workspacePanels.set(canonicalizeAndroidPath(shim.getWorkspaceDirectory()), initPanel.id);
    }
    console.log(`[claude-host] extension.js activated; panels=${shim.getPanels().size}; workspace=${shim.getWorkspaceDirectory()}`);
  } catch (err) {
    activationError = err;
    console.error("[claude-host] activation failed:", err && err.stack ? err.stack : err);
  }
}

async function ensureActivePanel(requestedPanelId) {
  const panels = shim.getPanels();
  if (requestedPanelId && panels.has(requestedPanelId)) {
    shim.setActivePanelId(requestedPanelId);
    return panels.get(requestedPanelId);
  }
  const canonWs = canonicalizeAndroidPath(shim.getWorkspaceDirectory());
  const mappedId = workspacePanels.get(canonWs);
  if (mappedId && panels.has(mappedId)) {
    shim.setActivePanelId(mappedId);
    return panels.get(mappedId);
  }
  let panel = shim.getActivePanel();
  if (!panel && extensionActivated) {
    await shim.vscodeApi.commands.executeCommand("claude-vscode.primaryEditor.open");
    panel = shim.getActivePanel();
    if (panel) workspacePanels.set(canonWs, panel.id);
  }
  return panel;
}

// -----------------------------------------------------------------------------
// Transform extension.js Webview HTML for Browser + WebSocket Bridge
// -----------------------------------------------------------------------------
function renderPanelHtml(panel, themeHint, initialSessionId) {
  const panelId = panel.id;
  let html = panel.webview.html || "";
  const optimisticAuth = getOptimisticWebviewAuthStatus();

  if (initialSessionId && /^[a-zA-Z0-9_-]{8,80}$/.test(initialSessionId)) {
    html = html.replace(/\sdata-initial-session="[^"]*"/g, "");
    html = html.replace('<div id="root"', `<div id="root" data-initial-session="${escapeHtmlAttr(initialSessionId)}"`);
  }
  if (optimisticAuth && !html.includes("data-initial-auth-status=")) {
    html = html.replace(
      '<div id="root"',
      `<div id="root" data-initial-auth-status="${escapeHtmlAttr(JSON.stringify(optimisticAuth))}"`
    );
  }

  // Replace restrictive VSCode nonce CSP with safe local loopback policy
  html = html.replace(
    /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self' http://127.0.0.1:${args.port} http://localhost:${args.port} ws://127.0.0.1:${args.port} ws://localhost:${args.port} data: blob:; style-src 'self' 'unsafe-inline' http://127.0.0.1:${args.port} http://localhost:${args.port}; script-src 'self' 'unsafe-inline' 'unsafe-eval' http://127.0.0.1:${args.port} http://localhost:${args.port} blob:; img-src 'self' data: blob: http://127.0.0.1:${args.port} http://localhost:${args.port} https:; font-src 'self' data: http://127.0.0.1:${args.port} http://localhost:${args.port}; connect-src 'self' http://127.0.0.1:${args.port} http://localhost:${args.port} ws://127.0.0.1:${args.port} ws://localhost:${args.port}; worker-src 'self' blob: http://127.0.0.1:${args.port};">`
  );

  // Ensure viewport prevents mobile input auto-zoom and honors notch/safe-area
  html = html.replace(
    /<meta\s+name="viewport"[^>]*>/i,
    `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">`
  );

  const resolvedTheme = themeHint === "light" ? "light" : "dark";
  const bodyClass = (resolvedTheme === "light" ? "vscode-light" : "vscode-dark") + (optimisticAuth ? " cc-authed" : "");
  html = html.replace(/<html lang="en">/i, `<html lang="en" data-cc-theme="${resolvedTheme}">`);
  html = html.replace(/<body>/i, `<body class="${bodyClass}">`);
  // Enable Anthropic's built-in authenticated header (Session Title, Past Conversations, New Session)
  // while keeping pre-login screen completely header-free.
  html = html.replace(/window\.IS_FULL_EDITOR\s*=\s*true/g, "window.IS_FULL_EDITOR = false");

  const bridgeScript = `
    <link rel="stylesheet" href="/ext/claude-theme.css">
    <script>
      (function() {
        var PANEL_ID = ${JSON.stringify(panelId)};
        window.__CC_PANEL_ID__ = PANEL_ID;
        window.__CC_INITIAL_WORKSPACE__ = ${JSON.stringify(canonicalizeAndroidPath(shim.getWorkspaceDirectory()))};
        var STATE_KEY = "__cc_vscode_state_" + PANEL_ID;
        try {
          var _reqSess = new URLSearchParams(window.location.search).get("session");
          if (_reqSess) sessionStorage.removeItem(STATE_KEY);
        } catch (_) {}
        var outQueue = [];
        var ws = null;
        var reconnectTimer = null;
        var reconnectDelayMs = 800;

        function connectWs() {
          var proto = location.protocol === "https:" ? "wss:" : "ws:";
          var url = proto + "//" + location.host + "/ws?panel=" + encodeURIComponent(PANEL_ID);
          ws = new WebSocket(url);
          ws.onopen = function() {
            reconnectDelayMs = 800;
            while (outQueue.length > 0 && ws.readyState === 1) {
              ws.send(outQueue.shift());
            }
          };
          ws.onmessage = function(ev) {
            try {
              var pkt = JSON.parse(ev.data);
              if (pkt && pkt.__cc_panel_msg) {
                window.dispatchEvent(new MessageEvent("message", { data: pkt.message, origin: window.location.origin }));
              } else if (pkt && pkt.__cc_host_event) {
                window.dispatchEvent(new CustomEvent("cc:host-event", { detail: pkt }));
              }
            } catch (err) {
              console.error("[cc-ws] parse error:", err);
            }
          };
          ws.onclose = function() {
            if (!reconnectTimer) {
              var waitMs = reconnectDelayMs;
              reconnectDelayMs = Math.min(8000, reconnectDelayMs * 2);
              reconnectTimer = setTimeout(function() {
                reconnectTimer = null;
                connectWs();
              }, waitMs);
            }
          };
        }
        connectWs();

        var apiInstance = {
          postMessage: function(msg) {
            var raw = JSON.stringify({ panelId: PANEL_ID, message: msg });
            if (ws && ws.readyState === 1) {
              ws.send(raw);
            } else if (outQueue.length < 256) {
              outQueue.push(raw);
            }
          },
          getState: function() {
            try {
              var s = sessionStorage.getItem(STATE_KEY);
              return s ? JSON.parse(s) : undefined;
            } catch (_) {
              return undefined;
            }
          },
          setState: function(nextState) {
            try {
              sessionStorage.setItem(STATE_KEY, JSON.stringify(nextState));
            } catch (_) {}
            return nextState;
          }
        };

        window.acquireVsCodeApi = function() {
          return apiInstance;
        };
      })();
    </script>
    <script src="/__cc_android_boot.js" defer></script>
  `;

  const headClose = html.indexOf("</head>");
  if (headClose !== -1) {
    html = html.slice(0, headClose) + bridgeScript + html.slice(headClose);
  } else {
    html = bridgeScript + html;
  }
  return html;
}

// -----------------------------------------------------------------------------
// Persistent Native PTY Session Manager (/pty) powered by cc-pty (TIOCSWINSZ)
// -----------------------------------------------------------------------------
const persistentPtys = new Map();
const MAX_PTY_SCROLLBACK = 131072;

function buildPtyEnvironment(cols, rows) {
  const prefixDir = path.join(HOME_DIR, "usr");
  const rbinDir = path.join(HOME_DIR, "runtime", "bin");
  const preloadCandidates = [];
  const goDns = path.join(prefixDir, "lib", "libagy-go-dns.so");
  const termuxExec = path.join(prefixDir, "lib", "libtermux-exec.so");
  if (fs.existsSync(goDns)) preloadCandidates.push(goDns);
  if (fs.existsSync(termuxExec)) preloadCandidates.push(termuxExec);

  const env = {
    ...process.env,
    HOME: HOME_DIR,
    PREFIX: prefixDir,
    TMPDIR: path.join(prefixDir, "tmp"),
    CLAUDE_CONFIG_DIR: CLAUDE_DIR,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    COLUMNS: String(cols),
    LINES: String(rows),
    ROWS: String(rows),
    COLS: String(cols),
    PATH: `${path.join(prefixDir, "bin")}:${rbinDir}:${path.join(HOME_DIR, ".local", "bin")}:/system/bin`,
    LD_LIBRARY_PATH: path.join(prefixDir, "lib"),
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_CODE_DISABLE_MOUSE: "1",
  };
  if (preloadCandidates.length > 0) {
    env.LD_PRELOAD = preloadCandidates.join(":");
  } else {
    delete env.LD_PRELOAD;
  }
  return env;
}

function createOrGetPtySession(sessionId, cwdParam, cols, rows) {
  let sess = persistentPtys.get(sessionId);
  if (sess && sess.alive) {
    sess.resize(rows, cols);
    return sess;
  }

  const safeCwd = (cwdParam && fs.existsSync(cwdParam)) ? cwdParam : (fs.existsSync(shim.getWorkspaceDirectory()) ? shim.getWorkspaceDirectory() : HOME_DIR);
  const prefixDir = path.join(HOME_DIR, "usr");
  const ccPtyCandidates = [
    process.env.CC_PTY_BIN,
    path.join(HOME_DIR, "runtime", "bin", "cc-pty"),
    path.join(prefixDir, "bin", "cc-pty"),
  ].filter(Boolean);
  const ccPtyBin = ccPtyCandidates.find((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  });

  const prefixBash = path.join(prefixDir, "bin", "bash");
  const rcFile = path.join(prefixDir, "etc", "cc.bashrc");
  const hasBash = fs.existsSync(prefixBash);
  const shellCmd = hasBash ? prefixBash : "/system/bin/sh";
  const shellArgs = hasBash
    ? (fs.existsSync(rcFile) ? ["--noprofile", "--rcfile", rcFile, "-i"] : ["-i"])
    : ["-i"];

  const childEnv = buildPtyEnvironment(cols, rows);
  let child;
  let hasResizePipe = false;
  if (ccPtyBin) {
    child = spawn(ccPtyBin, [shellCmd, ...shellArgs], {
      cwd: safeCwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    hasResizePipe = Boolean(child.stdio && child.stdio[3]);
  } else {
    child = spawn(shellCmd, shellArgs, {
      cwd: safeCwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  sess = {
    id: sessionId,
    cwd: safeCwd,
    child,
    alive: true,
    scrollback: "",
    clients: new Set(),
    write(data) {
      if (sess.alive && child.stdin && child.stdin.writable) {
        child.stdin.write(data);
      }
    },
    resize(r, c) {
      const nr = Math.max(5, Math.min(200, Number(r) || 24));
      const nc = Math.max(20, Math.min(400, Number(c) || 80));
      if (sess.alive && hasResizePipe && child.stdio[3] && child.stdio[3].writable) {
        try { child.stdio[3].write(`${nr} ${nc}\n`); } catch (_) {}
      }
    },
    kill() {
      sess.alive = false;
      persistentPtys.delete(sessionId);
      try { child.kill("SIGTERM"); } catch (_) {}
    },
  };

  const onChunk = (chunk) => {
    const str = chunk.toString("utf8");
    sess.scrollback += str;
    if (sess.scrollback.length > MAX_PTY_SCROLLBACK) {
      sess.scrollback = sess.scrollback.slice(-Math.floor(MAX_PTY_SCROLLBACK * 0.75));
    }
    for (const cl of sess.clients) {
      cl.sendJson({ type: "output", data: str });
    }
  };

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.on("exit", (code) => {
    sess.alive = false;
    persistentPtys.delete(sessionId);
    for (const cl of sess.clients) {
      cl.sendJson({ type: "exit", code: code ?? 0 });
    }
  });
  child.on("error", (err) => {
    onChunk(Buffer.from(`\r\n[pty error: ${err.message}]\r\n`, "utf8"));
  });

  persistentPtys.set(sessionId, sess);
  return sess;
}

function attachPtyWebSocket(req, socket, parsedUrl) {
  const rawCwd = parsedUrl.searchParams.get("cwd") || shim.getWorkspaceDirectory();
  const safeBaseCwd = (rawCwd && fs.existsSync(rawCwd))
    ? rawCwd
    : (fs.existsSync(shim.getWorkspaceDirectory()) ? shim.getWorkspaceDirectory() : HOME_DIR);
  const resolvedCwd = path.resolve(safeBaseCwd);
  const rawId = parsedUrl.searchParams.get("id") || "";
  const sessionId = (!rawId || rawId === "main" || rawId === "auto")
    ? ("ws:" + resolvedCwd)
    : rawId;
  const cols = Math.max(20, Math.min(300, Number(parsedUrl.searchParams.get("cols") || 92)));
  const rows = Math.max(6, Math.min(150, Number(parsedUrl.searchParams.get("rows") || 24)));

  let sess = createOrGetPtySession(sessionId, resolvedCwd, cols, rows);

  const ws = acceptWebSocket(
    req,
    socket,
    (buf) => {
      const txt = buf.toString("utf8");
      try {
        if (txt.startsWith("{")) {
          const ctrl = JSON.parse(txt);
          if (ctrl && ctrl.type === "input" && typeof ctrl.data === "string") {
            if (!sess.alive) {
              sess = createOrGetPtySession(sessionId, resolvedCwd, cols, rows);
              sess.clients.add(ws);
            }
            sess.write(ctrl.data);
            return;
          }
          if (ctrl && ctrl.type === "resize") {
            sess.resize(ctrl.rows, ctrl.cols);
            return;
          }
          if (ctrl && ctrl.type === "restart") {
            const nextCwd = (ctrl.cwd && fs.existsSync(ctrl.cwd)) ? path.resolve(ctrl.cwd) : resolvedCwd;
            sess.clients.delete(ws);
            sess.kill();
            sess = createOrGetPtySession(sessionId, nextCwd, ctrl.cols || cols, ctrl.rows || rows);
            sess.clients.add(ws);
            ws.sendJson({ type: "restarted", cwd: sess.cwd });
            return;
          }
          if (ctrl && ctrl.type === "kill") {
            sess.clients.delete(ws);
            sess.kill();
            ws.close();
            return;
          }
        }
      } catch (_) {}
      sess.write(buf);
    },
    (closedWs) => {
      if (sess) sess.clients.delete(closedWs);
    }
  );

  if (!ws) return;
  sess.clients.add(ws);
  if (sess.scrollback.length > 0) {
    ws.sendJson({ type: "output", data: sess.scrollback });
  }
}

// -----------------------------------------------------------------------------
// Static MIME & JSON Helpers
// -----------------------------------------------------------------------------
const MIME_MAP = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".cjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.length,
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function listDirectorySafe(targetPath, hideGit = false) {
  const norm = path.posix.normalize(String(targetPath || "/").replace(/\\/g, "/"));
  const virtualMap = {
    "/": ["/storage", "/sdcard", "/data"],
    "/storage": ["/storage/emulated"],
    "/storage/emulated": ["/storage/emulated/0"],
    "/data": ["/data/user"],
    "/data/user": ["/data/user/0"],
    "/data/user/0": [path.dirname(HOME_DIR)],
  };
  try {
    if (!virtualMap[norm] && fs.existsSync(norm)) {
      const entries = fs.readdirSync(norm, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith(".trashed") && (!hideGit || e.name !== ".git"))
        .map((e) => {
          const fullPath = path.join(norm, e.name);
          const isDir = e.isDirectory();
          let size = 0;
          if (!isDir) {
            try { size = fs.statSync(fullPath).size; } catch (_) {}
          }
          return {
            name: e.name,
            path: fullPath,
            type: isDir ? "directory" : "file",
            size,
          };
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
      return { directory: norm, parent: path.dirname(norm), items };
    }
  } catch (_) {}

  if (virtualMap[norm]) {
    return {
      directory: norm,
      parent: path.dirname(norm),
      items: virtualMap[norm].map((p) => ({ name: path.basename(p), path: p, type: "directory", size: 0 })),
    };
  }
  return { directory: norm, parent: path.dirname(norm), items: [] };
}

function readAuthConfigSummary() {
  const settingsPath = path.join(CLAUDE_DIR, "settings.json");
  let cfg = {};
  try {
    if (fs.existsSync(settingsPath)) cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (_) {}
  const envCfg = (cfg && cfg.env && typeof cfg.env === "object") ? cfg.env : {};
  const apiKey = secretApiKey || (SECRET_STORE_ACTIVE ? "" : (envCfg.ANTHROPIC_API_KEY || envCfg.ANTHROPIC_AUTH_TOKEN || ""));
  const maskedKey = apiKey ? (apiKey.slice(0, 7) + "..." + apiKey.slice(-4)) : "";
  const credsFile = path.join(CLAUDE_DIR, ".credentials.json");
  const backupCredsFile = path.join(CLAUDE_DIR, ".credentials.oauth-backup.json");
  const hasOAuth = fs.existsSync(credsFile);
  const hasOAuthBackup = fs.existsSync(backupCredsFile);
  const activeMode = hasOAuth ? "oauth" : (apiKey ? "apikey" : "none");
  return {
    activeMode,
    hasApiKey: Boolean(apiKey),
    maskedApiKey: maskedKey,
    hasOAuth,
    hasOAuthBackup,
    baseUrl: envCfg.ANTHROPIC_BASE_URL || "",
    model: envCfg.ANTHROPIC_MODEL || cfg.model || "",
    sandboxDisabled: cfg?.sandbox?.enabled === false,
  };
}

async function updateAuthConfig(body) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  const settingsPath = path.join(CLAUDE_DIR, "settings.json");
  const credsFile = path.join(CLAUDE_DIR, ".credentials.json");
  const backupCredsFile = path.join(CLAUDE_DIR, ".credentials.oauth-backup.json");

  let cfg = {};
  try {
    if (fs.existsSync(settingsPath)) cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (_) {}
  if (!cfg || typeof cfg !== "object") cfg = {};
  if (!cfg.env || typeof cfg.env !== "object") cfg.env = {};
  if (!cfg.sandbox || typeof cfg.sandbox !== "object") cfg.sandbox = {};
  cfg.sandbox.enabled = false;

  const wantsClear = body.clearApiKey === true || body.apiKey === "" || body.authMode === "oauth";

  if (typeof body.baseUrl === "string") {
    const u = body.baseUrl.trim();
    if (u && !wantsClear) {
      cfg.env.ANTHROPIC_BASE_URL = u;
      process.env.ANTHROPIC_BASE_URL = u;
    } else {
      delete cfg.env.ANTHROPIC_BASE_URL;
      delete process.env.ANTHROPIC_BASE_URL;
    }
  }

  if (typeof body.model === "string") {
    const m = body.model.trim();
    if (m && !wantsClear) {
      cfg.env.ANTHROPIC_MODEL = m;
      cfg.model = m;
      process.env.ANTHROPIC_MODEL = m;
    } else if (wantsClear || m === "") {
      delete cfg.env.ANTHROPIC_MODEL;
      delete cfg.model;
      delete process.env.ANTHROPIC_MODEL;
    }
  }

  const effectiveBaseUrl = cfg.env.ANTHROPIC_BASE_URL || "";

  if (wantsClear) {
    for (const n of SECRET_ENV_NAMES) delete cfg.env[n];
    secretApiKey = "";
    applyApiKeyToProcessEnv("", false);
    // Restore backed-up Claude.ai OAuth credentials if available
    if (!fs.existsSync(credsFile) && fs.existsSync(backupCredsFile)) {
      try { fs.renameSync(backupCredsFile, credsFile); } catch (_) {}
    }
  } else {
    const incomingKey = (typeof body.apiKey === "string" && body.apiKey.trim().length > 0)
      ? body.apiKey.trim()
      : (secretApiKey || (SECRET_STORE_ACTIVE ? "" : (cfg.env.ANTHROPIC_API_KEY || cfg.env.ANTHROPIC_AUTH_TOKEN || "")));

    if (incomingKey) {
      // Back up active Claude.ai OAuth credentials so s4() doesn't shadow API Key / 3rd-party endpoints
      if (fs.existsSync(credsFile)) {
        try {
          fs.copyFileSync(credsFile, backupCredsFile);
          fs.unlinkSync(credsFile);
        } catch (_) {}
      }
      const useBearer = Boolean(body.useBearerToken || effectiveBaseUrl);
      secretApiKey = incomingKey;
      if (SECRET_STORE_ACTIVE) {
        // Persisted encrypted by Android (Keystore); never written here.
        for (const n of SECRET_ENV_NAMES) delete cfg.env[n];
      } else if (useBearer) {
        cfg.env.ANTHROPIC_AUTH_TOKEN = incomingKey;
        cfg.env.ANTHROPIC_API_KEY = incomingKey;
      } else {
        cfg.env.ANTHROPIC_API_KEY = incomingKey;
        delete cfg.env.ANTHROPIC_AUTH_TOKEN;
      }
      applyApiKeyToProcessEnv(incomingKey, useBearer);
    }
  }

  // Write settings.json BEFORE notifying configuration listeners or spawning new panels
  const tmp = settingsPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, settingsPath);

  // Secrets reach claude through process.env; never list them in the persisted host config.
  const envVarsList = Object.entries(cfg.env)
    .filter(([name]) => !SECRET_ENV_NAMES.includes(name))
    .map(([name, value]) => ({ name, value: String(value) }));
  shim.updateHostSetting("claudeCode.environmentVariables", envVarsList);

  // Dispose stale panels so the newly created panel instantiates a fresh AuthManager(yo()) & CLI session
  if (extensionActivated) {
    workspacePanels.clear();
    for (const p of Array.from(shim.getPanels().values())) {
      try { p.dispose(); } catch (_) {}
    }
    await shim.vscodeApi.commands.executeCommand("claude-vscode.primaryEditor.open");
    const freshPanel = shim.getActivePanel();
    if (freshPanel) {
      workspacePanels.set(canonicalizeAndroidPath(shim.getWorkspaceDirectory()), freshPanel.id);
    }
  }

  return {
    ...readAuthConfigSummary(),
    activePanelId: shim.getActivePanel()?.id || null,
  };
}

async function signOutCompletely() {
  if (extensionActivated) {
    try {
      await shim.vscodeApi.commands.executeCommand("claude-vscode.logout");
    } catch (_) {}
  }
  const credsFile = path.join(CLAUDE_DIR, ".credentials.json");
  const backupCredsFile = path.join(CLAUDE_DIR, ".credentials.oauth-backup.json");
  await fsp.rm(credsFile, { force: true }).catch(() => {});
  await fsp.rm(backupCredsFile, { force: true }).catch(() => {});

  const settingsPath = path.join(CLAUDE_DIR, "settings.json");
  let cfg = {};
  try {
    if (fs.existsSync(settingsPath)) cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (_) {}
  if (!cfg || typeof cfg !== "object") cfg = {};
  if (!cfg.env || typeof cfg.env !== "object") cfg.env = {};
  for (const n of SECRET_ENV_NAMES) delete cfg.env[n];
  delete cfg.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;
  secretApiKey = "";
  applyApiKeyToProcessEnv("", false);

  try {
    const tmp = settingsPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, settingsPath);
  } catch (_) {}

  const envVarsList = Object.entries(cfg.env)
    .filter(([name]) => !SECRET_ENV_NAMES.includes(name))
    .map(([name, value]) => ({ name, value: String(value) }));
  shim.updateHostSetting("claudeCode.environmentVariables", envVarsList);

  if (extensionActivated) {
    try {
      fs.mkdirSync(APP_DEFAULT_WORKSPACE, { recursive: true });
      shim.setWorkspaceDirectory(APP_DEFAULT_WORKSPACE);
      saveLastWorkspace(APP_DEFAULT_WORKSPACE);
      process.chdir(APP_DEFAULT_WORKSPACE);
    } catch (_) {}
    workspacePanels.clear();
    for (const p of Array.from(shim.getPanels().values())) {
      try { p.dispose(); } catch (_) {}
    }
    await shim.vscodeApi.commands.executeCommand("claude-vscode.primaryEditor.open");
    const freshPanel = shim.getActivePanel();
    if (freshPanel) {
      workspacePanels.set(canonicalizeAndroidPath(shim.getWorkspaceDirectory()), freshPanel.id);
    }
  }

  return {
    ...readAuthConfigSummary(),
    activePanelId: shim.getActivePanel()?.id || null,
  };
}

function listInstalledSkillsAndMcp() {
  const skillsDir = path.join(CLAUDE_DIR, "skills");
  const skills = [];
  try {
    if (fs.existsSync(skillsDir)) {
      for (const e of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (e.isDirectory() || e.isSymbolicLink()) {
          const skillMd = path.join(skillsDir, e.name, "SKILL.md");
          skills.push({
            name: e.name,
            hasSkillMd: fs.existsSync(skillMd),
            skillMdPath: skillMd,
          });
        }
      }
    }
  } catch (_) {}

  const claudeJsonPath = CLAUDE_GLOBAL_CONFIG;
  let mcpServers = {};
  try {
    if (fs.existsSync(claudeJsonPath)) {
      const cj = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
      if (cj && cj.mcpServers && typeof cj.mcpServers === "object") {
        mcpServers = cj.mcpServers;
      }
    }
  } catch (_) {}

  return {
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    mcpServers: Object.keys(mcpServers),
    globalClaudeMd: path.join(CLAUDE_DIR, "CLAUDE.md"),
    projectClaudeMd: path.join(shim.getWorkspaceDirectory(), "CLAUDE.md"),
  };
}

function extractZipBufferToSkills(zipBuf, fallbackSkillName) {
  const zlib = require("zlib");
  // Locate End of Central Directory (0x06054b50)
  let eocdOffset = -1;
  const minSearch = Math.max(0, zipBuf.length - 65557);
  for (let i = zipBuf.length - 22; i >= minSearch; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Invalid .zip / .skill archive");
  }
  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  if (totalEntries === 0 || totalEntries > 2000) {
    throw new Error("Invalid entry count in zip archive");
  }

  const parsedEntries = [];
  let ptr = cdOffset;
  for (let idx = 0; idx < totalEntries && ptr + 46 <= zipBuf.length; idx++) {
    if (zipBuf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = zipBuf.readUInt16LE(ptr + 10);
    const compSize = zipBuf.readUInt32LE(ptr + 20);
    const uncompSize = zipBuf.readUInt32LE(ptr + 24);
    const nameLen = zipBuf.readUInt16LE(ptr + 28);
    const extraLen = zipBuf.readUInt16LE(ptr + 30);
    const commentLen = zipBuf.readUInt16LE(ptr + 32);
    const localHdrOffset = zipBuf.readUInt32LE(ptr + 42);
    const rawName = zipBuf.slice(ptr + 46, ptr + 46 + nameLen).toString("utf8").replace(/\\/g, "/");
    ptr += 46 + nameLen + extraLen + commentLen;

    if (!rawName || rawName.endsWith("/") || rawName.includes("__MACOSX/") || path.basename(rawName).startsWith("._")) {
      continue;
    }
    if (uncompSize > 32 * 1024 * 1024) {
      throw new Error("Skill file exceeds 32 MB safety limit");
    }
    if (localHdrOffset + 30 > zipBuf.length || zipBuf.readUInt32LE(localHdrOffset) !== 0x04034b50) {
      throw new Error("Corrupted local file header in zip");
    }
    const lNameLen = zipBuf.readUInt16LE(localHdrOffset + 26);
    const lExtraLen = zipBuf.readUInt16LE(localHdrOffset + 28);
    const dataStart = localHdrOffset + 30 + lNameLen + lExtraLen;
    const compSlice = zipBuf.slice(dataStart, dataStart + compSize);
    let content;
    if (method === 0) {
      content = compSlice;
    } else if (method === 8) {
      content = zlib.inflateRawSync(compSlice);
    } else {
      throw new Error(`Unsupported zip compression method: ${method}`);
    }
    parsedEntries.push({ rawName: rawName.replace(/^\/+/, ""), content });
  }

  if (parsedEntries.length === 0) {
    throw new Error("Archive contains no files");
  }

  // Determine skill folder name & relative paths
  const rootSkillEntry = parsedEntries.find((e) => e.rawName === "SKILL.md");
  let skillName = "";
  let stripPrefix = "";

  if (rootSkillEntry) {
    const mdText = rootSkillEntry.content.toString("utf8");
    const m = mdText.match(/^---\s*[\r\n]+[\s\S]*?^name:\s*["']?([a-zA-Z0-9._-]+)["']?/m);
    skillName = (m && m[1]) ? m[1] : fallbackSkillName;
  } else {
    const nestedSkillEntry = parsedEntries.find((e) => /^[^/]+\/SKILL\.md$/.test(e.rawName));
    if (nestedSkillEntry) {
      const topFolder = nestedSkillEntry.rawName.split("/")[0];
      stripPrefix = topFolder + "/";
      skillName = topFolder;
    } else {
      throw new Error("Archive must contain SKILL.md (at root or inside <skill-name>/SKILL.md)");
    }
  }

  skillName = String(skillName || "custom-skill")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "") || "custom-skill";

  const skillsRoot = path.resolve(CLAUDE_DIR, "skills");
  const targetSkillDir = path.resolve(skillsRoot, skillName);
  if (!targetSkillDir.startsWith(skillsRoot + path.sep)) {
    throw new Error("Invalid skill name");
  }
  fs.mkdirSync(targetSkillDir, { recursive: true });

  let writtenFiles = 0;
  for (const item of parsedEntries) {
    let rel = stripPrefix && item.rawName.startsWith(stripPrefix)
      ? item.rawName.slice(stripPrefix.length)
      : item.rawName;
    rel = rel.replace(/^\/+/, "");
    if (!rel || rel.includes("..")) continue;
    const outPath = path.resolve(targetSkillDir, rel);
    if (outPath !== targetSkillDir && !outPath.startsWith(targetSkillDir + path.sep)) {
      throw new Error("Blocked Zip-Slip path: " + rel);
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, item.content);
    writtenFiles++;
  }

  return { skillName, targetSkillDir, writtenFiles };
}

// The sidebar polls the tree every 10 s; only re-parse transcripts whose size/mtime changed.
const sessionInfoCache = new Map(); // filePath -> { size, mtimeMs, info }

function parseJsonlSessionFast(filePath, sessionId) {
  try {
    const st = fs.statSync(filePath);
    const hit = sessionInfoCache.get(filePath);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.info;
    const info = parseJsonlSessionUncached(filePath, sessionId, st);
    if (sessionInfoCache.size > 2000) sessionInfoCache.clear();
    sessionInfoCache.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, info });
    return info;
  } catch (_) {
    sessionInfoCache.delete(filePath);
    return null;
  }
}

function parseJsonlSessionUncached(filePath, sessionId, st) {
  let fd = -1;
  try {
    if (!st.isFile() || st.size === 0) return null;
    fd = fs.openSync(filePath, "r");
    const headLen = Math.min(st.size, 24576);
    const headBuf = Buffer.allocUnsafe(headLen);
    fs.readSync(fd, headBuf, 0, headLen, 0);
    const headStr = headBuf.toString("utf8");

    const firstNl = headStr.indexOf("\n");
    const firstLine = firstNl >= 0 ? headStr.slice(0, firstNl) : headStr;
    if (firstLine.includes('"isSidechain":true') || firstLine.includes('"isSidechain": true')) {
      return null;
    }

    let tailStr = headStr;
    if (st.size > headLen) {
      const tailLen = Math.min(st.size, 24576);
      const tailBuf = Buffer.allocUnsafe(tailLen);
      fs.readSync(fd, tailBuf, 0, tailLen, st.size - tailLen);
      tailStr = tailBuf.toString("utf8");
    }

    let cwd = "";
    let customTitle = "";
    let summary = "";
    let firstPrompt = "";

    const scanLines = (chunk, isTail) => {
      const lines = chunk.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith("{") || !line.endsWith("}")) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.cwd && typeof obj.cwd === "string" && (!cwd || isTail)) {
            cwd = obj.cwd;
          }
          if (obj.relocatedCwd && typeof obj.relocatedCwd === "string") {
            cwd = obj.relocatedCwd;
          }
          if ((obj.type === "custom-title" || obj.type === "ai-title") && typeof obj.customTitle === "string" && obj.customTitle.trim()) {
            customTitle = obj.customTitle.trim();
          } else if (typeof obj.customTitle === "string" && obj.customTitle.trim()) {
            customTitle = obj.customTitle.trim();
          }
          if (obj.type === "summary" && typeof obj.summary === "string" && obj.summary.trim()) {
            summary = obj.summary.trim();
          } else if (typeof obj.lastPrompt === "string" && obj.lastPrompt.trim() && !summary) {
            summary = obj.lastPrompt.trim();
          }
          if (!firstPrompt && obj.type === "user" && obj.message) {
            const c = obj.message.content;
            if (typeof c === "string" && c.trim() && !c.startsWith("<")) {
              firstPrompt = c.trim();
            } else if (Array.isArray(c)) {
              for (const part of c) {
                if (part && part.type === "text" && typeof part.text === "string" && part.text.trim() && !part.text.startsWith("<")) {
                  firstPrompt = part.text.trim();
                  break;
                }
              }
            }
          }
        } catch (_) {}
      }
    };

    scanLines(headStr, false);
    if (tailStr !== headStr) scanLines(tailStr, true);

    const rawTitle = customTitle || summary || firstPrompt;
    if (!rawTitle) return null;
    const cleanTitle = rawTitle.replace(/\s+/g, " ").slice(0, 90);
    return {
      id: sessionId,
      title: cleanTitle,
      cwd: cwd || "",
      updatedAt: Math.floor(st.mtimeMs),
    };
  } catch (_) {
    return null;
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

const READ_ONLY_TOOL_NAMES = new Set([
  "Read", "Glob", "Grep", "LS", "View", "WebFetch", "WebSearch",
  "TodoRead", "TodoWrite", "Task", "AskUserQuestion", "NotebookRead"
]);

function readSessionFileRenames() {
  try {
    if (fs.existsSync(SESSION_FILE_RENAMES_FILE)) {
      const obj = JSON.parse(fs.readFileSync(SESSION_FILE_RENAMES_FILE, "utf8"));
      if (obj && typeof obj === "object") return obj;
    }
  } catch (_) {}
  return {};
}

function recordSessionFileRename(oldPath, newPath) {
  try {
    const map = readSessionFileRenames();
    const canonOld = canonicalizeAndroidPath(oldPath);
    const canonNew = canonicalizeAndroidPath(newPath);
    if (!canonOld || !canonNew || canonOld === canonNew) return;
    // Update any existing chain pointing to canonOld
    for (const k of Object.keys(map)) {
      if (map[k] === canonOld) map[k] = canonNew;
    }
    map[canonOld] = canonNew;
    const mapKeys = Object.keys(map);
    if (mapKeys.length > 400) {
      for (const staleKey of mapKeys.slice(0, mapKeys.length - 400)) {
        delete map[staleKey];
      }
    }
    fs.mkdirSync(HOST_STORAGE_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE_RENAMES_FILE, JSON.stringify(map, null, 2), { mode: 0o600 });
  } catch (_) {}
}

function listSessionTouchedFiles(sessionId) {
  if (!sessionId || !/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) {
    return { sessionId: "", files: [] };
  }
  const projectsRoot = path.join(CLAUDE_DIR, "projects");
  if (!fs.existsSync(projectsRoot)) {
    return { sessionId, files: [] };
  }

  let transcriptPath = "";
  for (const dirEnt of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!dirEnt.isDirectory()) continue;
    const cand = path.join(projectsRoot, dirEnt.name, `${sessionId}.jsonl`);
    if (fs.existsSync(cand)) {
      transcriptPath = cand;
      break;
    }
  }
  if (!transcriptPath) {
    return { sessionId, files: [] };
  }

  let raw = "";
  let stat = null;
  try {
    stat = fs.statSync(transcriptPath);
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch (_) {
    return { sessionId, files: [] };
  }

  let sessionCwd = canonicalizeAndroidPath(shim.getWorkspaceDirectory());
  let sessionStartMs = 0;
  const touched = new Map();
  const bashCandidatePaths = new Set();

  const registerPath = (rawCandidate, baseDir, action) => {
    if (!rawCandidate || typeof rawCandidate !== "string") return;
    const trimmed = rawCandidate.trim();
    if (!trimmed || trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("/dev/")) return;
    const resolved = trimmed.startsWith("/")
      ? canonicalizeAndroidPath(trimmed)
      : canonicalizeAndroidPath(path.resolve(baseDir || sessionCwd, trimmed));
    if (!resolved) return;
    const prev = touched.get(resolved);
    if (!prev || action === "created") {
      touched.set(resolved, { action: action || "edited" });
    }
  };

  const harvestBashPaths = (text) => {
    if (!text || typeof text !== "string") return;
    const absRe = /(?:\/storage\/emulated\/0|\/sdcard)\/[A-Za-z0-9._\-/]+\.[A-Za-z0-9]{1,10}/g;
    let m;
    while ((m = absRe.exec(text)) !== null) {
      bashCandidatePaths.add(canonicalizeAndroidPath(m[0]));
    }
  };

  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.cwd && typeof obj.cwd === "string") {
        sessionCwd = canonicalizeAndroidPath(obj.cwd) || sessionCwd;
      }
      if (obj.relocatedCwd && typeof obj.relocatedCwd === "string") {
        sessionCwd = canonicalizeAndroidPath(obj.relocatedCwd) || sessionCwd;
      }
      if (!sessionStartMs && obj.timestamp) {
        const ts = Date.parse(obj.timestamp);
        if (!Number.isNaN(ts) && ts > 0) sessionStartMs = ts;
      }

      if (obj.type === "file-history-snapshot" && obj.snapshot && obj.snapshot.trackedFileBackups) {
        for (const tp of Object.keys(obj.snapshot.trackedFileBackups)) {
          registerPath(tp, sessionCwd, "edited");
        }
      } else if (obj.type === "file-history-delta" && typeof obj.trackingPath === "string") {
        registerPath(obj.trackingPath, sessionCwd, "edited");
      } else if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
        for (const part of obj.message.content) {
          if (!part || part.type !== "tool_use" || !part.input || typeof part.input !== "object") continue;
          const tName = String(part.name || "");
          if (READ_ONLY_TOOL_NAMES.has(tName)) continue;
          const inp = part.input;
          if (tName === "Write") {
            registerPath(inp.file_path || inp.path, sessionCwd, "created");
          } else if (tName === "Edit" || tName === "MultiEdit") {
            registerPath(inp.file_path || inp.path, sessionCwd, "edited");
          } else if (tName === "NotebookEdit") {
            registerPath(inp.notebook_path || inp.file_path, sessionCwd, "edited");
          } else if (tName === "Bash" && typeof inp.command === "string") {
            harvestBashPaths(inp.command);
          } else {
            const p = inp.file_path || inp.output_path || inp.dest_path || inp.save_path;
            if (typeof p === "string") registerPath(p, sessionCwd, "created");
          }
        }
      } else if (obj.type === "user" && obj.message && Array.isArray(obj.message.content)) {
        for (const part of obj.message.content) {
          if (part && part.type === "tool_result" && typeof part.content === "string") {
            harvestBashPaths(part.content);
          }
        }
      }
    } catch (_) {}
  }

  if (!sessionStartMs && stat) {
    sessionStartMs = Math.floor(stat.birthtimeMs || stat.mtimeMs);
  }

  for (const cand of bashCandidatePaths) {
    if (!cand || touched.has(cand)) continue;
    try {
      if (fs.existsSync(cand)) {
        const st = fs.statSync(cand);
        if (st.isFile() && st.mtimeMs >= sessionStartMs - 3000) {
          touched.set(cand, { action: "created" });
        }
      }
    } catch (_) {}
  }

  const renameMap = readSessionFileRenames();
  const internalClaudePrefix = path.resolve(CLAUDE_DIR) + path.sep;
  const resolvedFiles = new Map();

  for (const [origPath, meta] of touched.entries()) {
    let curPath = renameMap[origPath] || origPath;
    if (curPath.startsWith(internalClaudePrefix)) continue;
    try {
      if (!fs.existsSync(curPath)) continue;
      const fst = fs.statSync(curPath);
      if (!fst.isFile()) continue;
      resolvedFiles.set(curPath, {
        name: path.basename(curPath),
        path: curPath,
        size: fst.size,
        mtimeMs: Math.floor(fst.mtimeMs),
        action: meta.action,
      });
    } catch (_) {}
  }

  const files = Array.from(resolvedFiles.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { sessionId, files };
}

function renameChatSessionOnDisk(sessionId, rawTitle) {
  if (!sessionId || !/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) {
    throw new Error("Invalid session ID");
  }
  const cleanTitle = String(rawTitle || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!cleanTitle) {
    throw new Error("Title cannot be empty");
  }
  const projectsRoot = path.join(CLAUDE_DIR, "projects");
  const entryLine = JSON.stringify({ type: "custom-title", sessionId, customTitle: cleanTitle }) + "\n";
  let matched = 0;
  if (fs.existsSync(projectsRoot)) {
    for (const dirEnt of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!dirEnt.isDirectory()) continue;
      const targetJsonl = path.join(projectsRoot, dirEnt.name, `${sessionId}.jsonl`);
      if (fs.existsSync(targetJsonl)) {
        fs.appendFileSync(targetJsonl, entryLine, "utf8");
        matched++;
      }
    }
  }
  return { sessionId, title: cleanTitle, matched };
}

async function deleteChatSessionOnDisk(sessionId) {
  if (!sessionId || !/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) {
    throw new Error("Invalid session ID");
  }
  const projectsRoot = path.join(CLAUDE_DIR, "projects");
  let removed = 0;
  if (fs.existsSync(projectsRoot)) {
    for (const dirEnt of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!dirEnt.isDirectory()) continue;
      const projDir = path.join(projectsRoot, dirEnt.name);
      const targetJsonl = path.join(projDir, `${sessionId}.jsonl`);
      const targetSubDir = path.join(projDir, sessionId);
      if (fs.existsSync(targetJsonl)) {
        await fsp.rm(targetJsonl, { force: true });
        removed++;
      }
      if (fs.existsSync(targetSubDir)) {
        await fsp.rm(targetSubDir, { recursive: true, force: true });
      }
    }
  }
  return { sessionId, removed };
}

function removeWorkspaceFromList(wsPath) {
  const canon = canonicalizeAndroidPath(wsPath);
  if (!canon) throw new Error("Invalid workspace path");
  const hidden = readHiddenWorkspaces();
  hidden.add(canon);
  writeHiddenWorkspaces(hidden);

  const claudeJsonPath = CLAUDE_GLOBAL_CONFIG;
  try {
    if (fs.existsSync(claudeJsonPath)) {
      const cj = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
      if (cj && cj.projects && typeof cj.projects === "object") {
        let changed = false;
        for (const k of Object.keys(cj.projects)) {
          if (canonicalizeAndroidPath(k) === canon) {
            delete cj.projects[k];
            changed = true;
          }
        }
        if (changed) {
          const tmp = claudeJsonPath + ".tmp";
          fs.writeFileSync(tmp, JSON.stringify(cj, null, 2) + "\n", { mode: 0o600 });
          fs.renameSync(tmp, claudeJsonPath);
        }
      }
    }
  } catch (_) {}
  return { workspace: canon };
}

function isSensitiveAppPath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return true;
  const candidates = new Set();
  const norm = canonicalizeAndroidPath(rawPath);
  if (norm) candidates.add(norm);
  try {
    if (fs.existsSync(norm)) candidates.add(fs.realpathSync(norm));
    else if (fs.existsSync(path.dirname(norm))) {
      candidates.add(path.join(fs.realpathSync(path.dirname(norm)), path.basename(norm)));
    }
  } catch (_) {}

  const homeNorm = path.resolve(HOME_DIR);
  const appRoot1 = path.dirname(homeNorm); // e.g. /data/user/0/com.cc.ide
  const pkgName = path.basename(appRoot1);
  const appRoots = new Set([appRoot1, `/data/data/${pkgName}`, `/data/user/0/${pkgName}`]);

  const blockedDirs = [];
  for (const ar of appRoots) {
    blockedDirs.push(
      path.join(ar, "shared_prefs"),
      path.join(ar, "app_webview"),
      path.join(ar, "databases"),
      path.join(ar, "code_cache"),
      path.join(ar, "files", "runtime"),
      path.join(ar, "files", "web"),
      path.join(ar, "files", ".claude", "android-host")
    );
  }
  const blockedExact = new Set();
  for (const ar of appRoots) {
    blockedExact.add(path.join(ar, "files", ".claude", ".credentials.json"));
    blockedExact.add(path.join(ar, "files", ".claude", ".credentials.oauth-backup.json"));
    blockedExact.add(path.join(ar, "files", ".claude", ".device-keys.json"));
    blockedExact.add(path.join(ar, "files", ".claude", ".claude.json"));
  }

  for (const c of candidates) {
    if (blockedExact.has(c)) return true;
    const base = path.basename(c);
    if (base === ".credentials.json" || base === ".credentials.oauth-backup.json" || base === ".device-keys.json") {
      return true;
    }
    for (const d of blockedDirs) {
      if (c === d || c.startsWith(d + path.sep)) return true;
    }
  }
  return false;
}

function isProtectedDeletePath(resolvedPath) {
  const canon = canonicalizeAndroidPath(resolvedPath);
  const protectedSet = new Set([
    "/",
    "/storage",
    "/storage/emulated",
    "/storage/emulated/0",
    "/sdcard",
    "/data",
    "/data/user",
    "/data/user/0",
    path.resolve(HOME_DIR),
    path.resolve(CLAUDE_DIR),
    path.resolve(HOME_DIR, "usr"),
    path.resolve(HOME_DIR, "runtime"),
    path.resolve(HOME_DIR, "web"),
  ]);
  return protectedSet.has(canon) || protectedSet.has(path.resolve(resolvedPath));
}

function listWorkspacesAndChatsTree() {
  const activeWs = canonicalizeAndroidPath(shim.getWorkspaceDirectory());
  const hiddenSet = readHiddenWorkspaces();
  const wsMap = new Map();

  const ensureWs = (wsPath) => {
    if (!wsPath || typeof wsPath !== "string") return null;
    const norm = canonicalizeAndroidPath(wsPath);
    if (!norm) return null;
    if (norm === "/" || norm === HOME_DIR) {
      if (norm !== activeWs) return null;
    }
    if (norm !== activeWs && hiddenSet.has(norm)) return null;
    if (!wsMap.has(norm)) {
      let exists = false;
      try { exists = fs.existsSync(norm) && fs.statSync(norm).isDirectory(); } catch (_) {}
      if (!exists && norm !== activeWs) return null;
      wsMap.set(norm, {
        path: norm,
        name: path.basename(norm) || norm,
        active: norm === activeWs,
        lastActivity: norm === activeWs ? Date.now() : 0,
        sessions: [],
      });
    }
    return wsMap.get(norm);
  };

  ensureWs(activeWs);

  // 1. Known projects from the engine's global config ($CLAUDE_CONFIG_DIR/.claude.json)
  const claudeJsonPath = CLAUDE_GLOBAL_CONFIG;
  const seenSessions = new Set();
  try {
    if (fs.existsSync(claudeJsonPath)) {
      const cj = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
      if (cj && cj.projects && typeof cj.projects === "object") {
        for (const p of Object.keys(cj.projects)) {
          ensureWs(p);
        }
      }
    }
  } catch (_) {}

  // 2. Scan ~/.claude/projects/<slug>/<sessionId>.jsonl
  const projectsRoot = path.join(CLAUDE_DIR, "projects");
  try {
    if (fs.existsSync(projectsRoot)) {
      for (const dirEnt of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
        if (!dirEnt.isDirectory()) continue;
        const projDir = path.join(projectsRoot, dirEnt.name);
        let files = [];
        try { files = fs.readdirSync(projDir); } catch (_) {}
        for (const fn of files) {
          if (!fn.endsWith(".jsonl")) continue;
          const sessionId = fn.slice(0, -6);
          if (seenSessions.has(sessionId)) continue;
          const info = parseJsonlSessionFast(path.join(projDir, fn), sessionId);
          if (!info) continue;
          seenSessions.add(sessionId);
          const targetWs = ensureWs(info.cwd || activeWs);
          if (targetWs) {
            targetWs.sessions.push({
              id: info.id,
              title: info.title,
              updatedAt: info.updatedAt,
            });
            if (info.updatedAt > targetWs.lastActivity && !targetWs.active) {
              targetWs.lastActivity = info.updatedAt;
            }
          }
        }
      }
    }
  } catch (_) {}

  const workspaces = Array.from(wsMap.values());
  for (const w of workspaces) {
    w.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  workspaces.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.lastActivity - a.lastActivity;
  });

  return {
    activeWorkspace: activeWs,
    workspaces,
  };
}

// -----------------------------------------------------------------------------
// HTTP + Upgrade Server
// -----------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    if (!isAuthorizedRequest(req)) {
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end("Unauthorized");
    }
    const parsed = new URL(req.url || "/", `http://127.0.0.1:${args.port}`);
    const pathname = parsed.pathname;

    // 1. Health & Engine Info (polled by Android CoreReadyProbe)
    if (pathname === "/api/info") {
      if (activationError) {
        return sendJson(res, 500, { ok: false, error: String(activationError.message || activationError) });
      }
      if (!extensionActivated) {
        return sendJson(res, 503, { ok: false, booting: true });
      }
      const auth = readAuthConfigSummary();
      const activeWsPath = canonicalizeAndroidPath(shim.getWorkspaceDirectory());
      const wsPty = persistentPtys.get("ws:" + activeWsPath);
      return sendJson(res, 200, {
        ok: true,
        name: "claude-code-android",
        version: "2.1.331",
        workspace: activeWsPath,
        workspacePtyAlive: Boolean(wsPty && wsPty.alive),
        panelCount: shim.getPanels().size,
        activePanelId: shim.getActivePanel()?.id || null,
        persistentPty: true,
        auth,
      });
    }

    // 2. Panels API (Multi-tab Claude sessions)
    if (pathname === "/api/panels" && req.method === "GET") {
      const list = Array.from(shim.getPanels().values()).map((p) => ({
        id: p.id,
        title: p.title,
        active: p.active,
      }));
      return sendJson(res, 200, { panels: list, activePanelId: shim.getActivePanel()?.id || null });
    }

    if (pathname === "/api/panels/new" && req.method === "POST") {
      const body = await readJsonBody(req);
      await shim.vscodeApi.commands.executeCommand("claude-vscode.primaryEditor.open", body.sessionId, body.prompt);
      const active = shim.getActivePanel();
      return sendJson(res, 200, { ok: true, panelId: active?.id || null });
    }

    if (pathname === "/api/panels/select" && req.method === "POST") {
      const body = await readJsonBody(req);
      const ok = shim.setActivePanelId(body.panelId);
      return sendJson(res, 200, { ok, activePanelId: shim.getActivePanel()?.id || null });
    }

    if (pathname === "/api/panels/close" && req.method === "POST") {
      const body = await readJsonBody(req);
      const p = shim.getPanels().get(body.panelId);
      if (p) p.dispose();
      const next = await ensureActivePanel();
      return sendJson(res, 200, { ok: true, activePanelId: next?.id || null });
    }

    // 3. Workspace Switcher, Multi-Project Tree, Session Actions & Directory Browser
    if (pathname === "/api/workspaces-tree" && req.method === "GET") {
      return sendJson(res, 200, listWorkspacesAndChatsTree());
    }

    if (pathname === "/api/sessions/files" && req.method === "GET") {
      const sid = String(parsed.searchParams.get("sessionId") || "").trim();
      return sendJson(res, 200, listSessionTouchedFiles(sid));
    }

    if (pathname === "/api/sessions/rename" && req.method === "POST") {
      const body = await readJsonBody(req);
      const info = renameChatSessionOnDisk(String(body.sessionId || "").trim(), body.title);
      broadcastHostEvent("session_renamed", { sessionId: info.sessionId, title: info.title });
      return sendJson(res, 200, { ok: true, ...info });
    }

    if (pathname === "/api/sessions/delete" && req.method === "POST") {
      const body = await readJsonBody(req);
      const info = await deleteChatSessionOnDisk(String(body.sessionId || "").trim());
      broadcastHostEvent("session_deleted", { sessionId: info.sessionId });
      return sendJson(res, 200, { ok: true, ...info });
    }

    if (pathname === "/api/workspaces/remove" && req.method === "POST") {
      const body = await readJsonBody(req);
      const info = removeWorkspaceFromList(String(body.workspace || "").trim());
      return sendJson(res, 200, { ok: true, ...info });
    }

    if (pathname === "/api/workspace" && req.method === "GET") {
      return sendJson(res, 200, { workspace: canonicalizeAndroidPath(shim.getWorkspaceDirectory()) });
    }

    if (pathname === "/api/workspace" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.workspace || typeof body.workspace !== "string") {
        return sendJson(res, 400, { ok: false, error: "workspace path required" });
      }
      const canonReq = canonicalizeAndroidPath(body.workspace.trim());
      const nextWs = shim.setWorkspaceDirectory(canonReq);
      const canonNext = canonicalizeAndroidPath(nextWs);
      saveLastWorkspace(canonNext);
      try { process.chdir(canonNext); } catch (_) {}

      const targetSessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : undefined;
      let active = shim.getActivePanel();

      // Zero-reload hot workspace switch on the live PanelHost (0ms, no WebView reload)
      if (active && active._claudeComms) {
        active._claudeComms.cwd = canonNext;
        if (active._claudeComms.teleportService && typeof active._claudeComms.teleportService === "object") {
          active._claudeComms.teleportService.cwd = canonNext;
          active._claudeComms.teleportService.currentRepoCache = undefined;
        }
        try { active._claudeComms.pushStateUpdate(); } catch (_) {}
        workspacePanels.set(canonNext, active.id);
        broadcastHostEvent("workspace_changed", { workspace: canonNext, activePanelId: active.id });
        return sendJson(res, 200, {
          ok: true,
          inPlace: true,
          workspace: canonNext,
          activePanelId: active.id,
          sessionId: targetSessionId || null,
        });
      }

      const panels = shim.getPanels();
      const existingPanelId = workspacePanels.get(canonNext);
      active = null;

      if (existingPanelId && panels.has(existingPanelId)) {
        shim.setActivePanelId(existingPanelId);
        active = panels.get(existingPanelId);
      } else {
        if (workspacePanels.size >= 6) {
          for (const [oldWs, oldId] of workspacePanels.entries()) {
            if (oldWs !== canonNext) {
              const oldP = panels.get(oldId);
              if (oldP) {
                try { oldP.dispose(); } catch (_) {}
              }
              workspacePanels.delete(oldWs);
              break;
            }
          }
        }
        if (targetSessionId) {
          await shim.vscodeApi.commands.executeCommand("claude-vscode.editor.open", targetSessionId);
        } else {
          await shim.vscodeApi.commands.executeCommand("claude-vscode.primaryEditor.open");
        }
        active = shim.getActivePanel();
        if (active) workspacePanels.set(canonNext, active.id);
      }

      broadcastHostEvent("workspace_changed", { workspace: canonNext, activePanelId: active?.id || null });
      return sendJson(res, 200, { ok: true, workspace: canonNext, activePanelId: active?.id || null, sessionId: targetSessionId || null });
    }

    if (pathname === "/api/fs/list" && req.method === "GET") {
      const target = parsed.searchParams.get("path") || shim.getWorkspaceDirectory();
      const hideGit = parsed.searchParams.get("hideGit") === "1";
      return sendJson(res, 200, listDirectorySafe(target, hideGit));
    }

    if (pathname === "/api/fs/create" && req.method === "POST") {
      const body = await readJsonBody(req);
      const parentDir = canonicalizeAndroidPath(body.parentDir || shim.getWorkspaceDirectory());
      const rawName = String(body.name || "").trim().replace(/[/\\]+/g, "");
      if (!parentDir || !rawName || rawName === "." || rawName === "..") {
        return sendJson(res, 400, { ok: false, error: "Invalid name" });
      }
      const fullPath = path.resolve(parentDir, rawName);
      if (!fullPath.startsWith(parentDir + path.sep) || isSensitiveAppPath(fullPath)) {
        return sendJson(res, 403, { ok: false, error: "Protected target path" });
      }
      if (fs.existsSync(fullPath)) {
        return sendJson(res, 400, { ok: false, error: "Already exists: " + rawName });
      }
      if (body.kind === "directory") {
        await fsp.mkdir(fullPath, { recursive: true });
      } else {
        await fsp.mkdir(path.dirname(fullPath), { recursive: true });
        await fsp.writeFile(fullPath, String(body.content ?? ""), "utf8");
      }
      return sendJson(res, 200, { ok: true, path: fullPath, name: rawName, kind: body.kind === "directory" ? "directory" : "file" });
    }

    if (pathname === "/api/fs/rename" && req.method === "POST") {
      const body = await readJsonBody(req);
      const srcPath = canonicalizeAndroidPath(body.targetPath || "");
      const newName = String(body.newName || "").trim().replace(/[/\\]+/g, "");
      if (!srcPath || !fs.existsSync(srcPath) || isProtectedDeletePath(srcPath) || isSensitiveAppPath(srcPath)) {
        return sendJson(res, 403, { ok: false, error: "Protected or invalid source path" });
      }
      if (!newName || newName === "." || newName === "..") {
        return sendJson(res, 400, { ok: false, error: "Invalid new name" });
      }
      const destPath = path.resolve(path.dirname(srcPath), newName);
      if (isSensitiveAppPath(destPath)) {
        return sendJson(res, 403, { ok: false, error: "Protected destination path" });
      }
      if (destPath !== srcPath && fs.existsSync(destPath)) {
        return sendJson(res, 400, { ok: false, error: "A file or folder with that name already exists" });
      }
      if (destPath !== srcPath) {
        await fsp.rename(srcPath, destPath);
        recordSessionFileRename(srcPath, destPath);
      }
      return sendJson(res, 200, { ok: true, oldPath: srcPath, newPath: destPath, name: newName });
    }

    if (pathname === "/api/fs/delete" && req.method === "POST") {
      const body = await readJsonBody(req);
      const targetPath = canonicalizeAndroidPath(body.targetPath || "");
      if (!targetPath || !fs.existsSync(targetPath) || isProtectedDeletePath(targetPath) || isSensitiveAppPath(targetPath)) {
        return sendJson(res, 403, { ok: false, error: "Protected or invalid path" });
      }
      await fsp.rm(targetPath, { recursive: true, force: true });
      return sendJson(res, 200, { ok: true, deletedPath: targetPath });
    }

    if (pathname === "/api/fs/raw" && req.method === "GET") {
      const target = parsed.searchParams.get("path") || "";
      if (!target || isSensitiveAppPath(target)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Forbidden");
      }
      let st = null;
      try { st = fs.statSync(target); } catch (_) {}
      if (!st || !st.isFile()) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const ext = path.extname(target).toLowerCase();
      const mime = MIME_MAP[ext] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": st.size,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      const stream = fs.createReadStream(target);
      stream.on("error", () => res.destroy());
      return stream.pipe(res);
    }

    // 4. Auth / API Key / Anthropic-Compatible Provider Configuration
    if (pathname === "/api/auth/config" && req.method === "GET") {
      return sendJson(res, 200, readAuthConfigSummary());
    }

    if (pathname === "/api/auth/config" && req.method === "POST") {
      const body = await readJsonBody(req);
      const summary = await updateAuthConfig(body);
      return sendJson(res, 200, { ok: true, auth: summary, activePanelId: summary.activePanelId });
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const summary = await signOutCompletely();
      return sendJson(res, 200, { ok: true, auth: summary, activePanelId: summary.activePanelId });
    }

    // 5. Skills, File Read/Write (CLAUDE.md & SKILL.md editor), Preview Close & DeepLink
    if (pathname === "/api/skills" && req.method === "GET") {
      return sendJson(res, 200, listInstalledSkillsAndMcp());
    }

    if (pathname === "/api/skills/import-zip" && req.method === "POST") {
      const body = await readJsonBody(req);
      const b64 = String(body.base64 || "");
      const fileName = String(body.fileName || "skill.zip").replace(/\.(zip|skill)$/i, "");
      if (!b64) {
        return sendJson(res, 400, { ok: false, error: "Empty zip payload" });
      }
      const zipBuf = Buffer.from(b64, "base64");
      const info = extractZipBufferToSkills(zipBuf, fileName);
      return sendJson(res, 200, { ok: true, ...info });
    }

    if (pathname === "/api/skills/save" && req.method === "POST") {
      const body = await readJsonBody(req);
      const safeName = String(body.name || "").trim().replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
      if (!safeName) {
        return sendJson(res, 400, { ok: false, error: "Invalid skill name" });
      }
      const skillsRoot = path.resolve(CLAUDE_DIR, "skills");
      const dir = path.resolve(skillsRoot, safeName);
      if (!dir.startsWith(skillsRoot + path.sep)) {
        return sendJson(res, 400, { ok: false, error: "Invalid skill path" });
      }
      fs.mkdirSync(dir, { recursive: true });
      const mdPath = path.join(dir, "SKILL.md");
      fs.writeFileSync(mdPath, String(body.content || ""), "utf8");
      return sendJson(res, 200, { ok: true, name: safeName, skillMdPath: mdPath });
    }

    if (pathname === "/api/skills/delete" && req.method === "POST") {
      const body = await readJsonBody(req);
      const safeName = String(body.name || "").trim();
      const skillsRoot = path.resolve(CLAUDE_DIR, "skills");
      const dir = path.resolve(skillsRoot, safeName);
      if (!safeName || !dir.startsWith(skillsRoot + path.sep)) {
        return sendJson(res, 400, { ok: false, error: "Invalid skill name" });
      }
      await fsp.rm(dir, { recursive: true, force: true });
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/fs/read" && req.method === "POST") {
      const body = await readJsonBody(req);
      const fp = canonicalizeAndroidPath(String(body.filePath || ""));
      if (!body.filePath || !fp.startsWith("/") || isSensitiveAppPath(fp)) {
        return sendJson(res, 403, { ok: false, error: "Protected or invalid file path" });
      }
      const st = fs.existsSync(fp) ? fs.statSync(fp) : null;
      const exists = Boolean(st && st.isFile());
      if (exists && st.size > 8 * 1024 * 1024) {
        return sendJson(res, 413, { ok: false, error: "File too large to edit here (over 8 MB)" });
      }
      const content = exists ? fs.readFileSync(fp, "utf8") : "";
      return sendJson(res, 200, { ok: true, filePath: fp, exists, content });
    }

    if (pathname === "/api/fs/write" && req.method === "POST") {
      const body = await readJsonBody(req);
      const fp = canonicalizeAndroidPath(String(body.filePath || ""));
      if (!body.filePath || !fp.startsWith("/") || isSensitiveAppPath(fp)) {
        return sendJson(res, 403, { ok: false, error: "Protected or invalid file path" });
      }
      await fsp.mkdir(path.dirname(fp), { recursive: true });
      await fsp.writeFile(fp, String(body.content ?? ""), "utf8");
      try {
        await shim.vscodeApi.workspace.openTextDocument(fp);
      } catch (_) {}
      return sendJson(res, 200, { ok: true, filePath: fp });
    }

    // Official claudeCode.* options that make sense on a phone (VS Code's Settings screen
    // does not exist on Android). Desktop-only ones (terminal mode, editor groups,
    // keyboard shortcuts, attach open file/selection, Python env) are intentionally left out.
    if (pathname === "/api/settings/general" && req.method === "GET") {
      const settings = GENERAL_SETTING_KEYS.map((key) => {
        const schema = shim.getSettingSchema(key) || {};
        return {
          key,
          type: schema.type || "boolean",
          enum: Array.isArray(schema.enum) ? schema.enum : null,
          description: String(schema.markdownDescription || schema.description || ""),
          value: shim.getHostSetting(key),
        };
      });
      return sendJson(res, 200, { settings });
    }

    if (pathname === "/api/settings/general" && req.method === "POST") {
      const body = await readJsonBody(req);
      const key = String(body.key || "");
      if (!GENERAL_SETTING_KEYS.includes(key)) {
        return sendJson(res, 400, { ok: false, error: "Unknown setting" });
      }
      const schema = shim.getSettingSchema(key) || {};
      let value = body.value;
      if (value === null) value = undefined; // reset to the official default
      if (value !== undefined) {
        const okType = schema.type === "boolean" ? typeof value === "boolean"
          : schema.type === "number" ? typeof value === "number" && Number.isFinite(value)
          : typeof value === "string";
        if (!okType || (Array.isArray(schema.enum) && !schema.enum.includes(value))) {
          return sendJson(res, 400, { ok: false, error: "Invalid value" });
        }
      }
      shim.updateHostSetting(key, value);
      return sendJson(res, 200, { ok: true, key, value: shim.getHostSetting(key) });
    }

    if (pathname === "/api/prompt/reply" && req.method === "POST") {
      const body = await readJsonBody(req);
      let value;
      if (typeof body.index === "number" && Number.isInteger(body.index)) value = body.index;
      else if (typeof body.value === "string") value = body.value;
      const ok = settleUserPrompt(String(body.promptId || ""), value);
      return sendJson(res, 200, { ok });
    }

    if (pathname === "/api/preview/close" && req.method === "POST") {
      const body = await readJsonBody(req);
      shim.closePreviewTabById(body.tabId || body.previewId);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/oauth/uri" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (body.uri) shim.handleDeepLinkUri(String(body.uri));
      return sendJson(res, 200, { ok: true });
    }

    // 6. Static Extension Assets (/ext/*)
    if (pathname.startsWith("/ext/")) {
      const rel = pathname.slice(5).split("/").map((s) => decodeURIComponent(s)).join(path.sep);
      const full = path.resolve(EXTENSION_DIR, rel);
      const normExt = path.resolve(EXTENSION_DIR);
      if (full !== normExt && !full.startsWith(normExt + path.sep)) {
        res.writeHead(403);
        return res.end("Forbidden");
      }
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        res.writeHead(404);
        return res.end("Not found");
      }
      const ext = path.extname(full).toLowerCase();
      const mime = MIME_MAP[ext] || "application/octet-stream";
      const stat = fs.statSync(full);
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": stat.size,
        "Cache-Control": "public, max-age=300",
      });
      return fs.createReadStream(full).pipe(res);
    }

    // 7. Serve Web Assets (/web/* or /__cc_*) when running outside Android LocalAssetServer
    if (pathname.startsWith("/__cc_")) {
      const relName = path.basename(pathname);
      const webCandidates = [
        path.join(HOME_DIR, "web", relName),
        path.resolve(EXTENSION_DIR, "..", "..", "web", relName),
      ];
      for (const cand of webCandidates) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          const ext = path.extname(cand).toLowerCase();
          res.writeHead(200, { "Content-Type": MIME_MAP[ext] || "application/octet-stream", "Cache-Control": "no-store" });
          return fs.createReadStream(cand).pipe(res);
        }
      }
    }

    // 8. Main Agentic UI Entry (GET /)
    if (pathname === "/" || pathname === "/index.html") {
      if (!extensionActivated) {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Claude Code Host starting...");
      }
      const reqPanelId = parsed.searchParams.get("panel") || undefined;
      const reqSessionId = parsed.searchParams.get("session") || undefined;
      const themeHint = parsed.searchParams.get("theme") || "dark";
      const panel = await ensureActivePanel(reqPanelId);
      if (!panel) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Failed to initialize Claude Code agentic panel");
      }
      const html = renderPanelHtml(panel, themeHint, reqSessionId);
      const buf = Buffer.from(html, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": buf.length,
      });
      return res.end(buf);
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  } catch (err) {
    console.error("[claude-host] HTTP error:", err && err.stack ? err.stack : err);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
  }
});

server.on("upgrade", (req, socket) => {
  try {
    if (!isAuthorizedRequest(req)) {
      try { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); } catch (_) {}
      socket.destroy();
      return;
    }
    const parsed = new URL(req.url || "/", `http://127.0.0.1:${args.port}`);
    if (parsed.pathname === "/pty") {
      attachPtyWebSocket(req, socket, parsed);
      return;
    }
    if (parsed.pathname === "/ws") {
      const panelId = parsed.searchParams.get("panel") || shim.getActivePanel()?.id || null;
      let clientEntry = null;
      const ws = acceptWebSocket(
        req,
        socket,
        (payloadBuf) => {
          try {
            const pkt = JSON.parse(payloadBuf.toString("utf8"));
            const targetId = pkt.panelId || panelId || shim.getActivePanel()?.id;
            const targetPanel = targetId ? shim.getPanels().get(targetId) : shim.getActivePanel();
            if (targetPanel && pkt.message !== undefined) {
              targetPanel.webview._receiveFromClient(pkt.message);
            }
          } catch (e) {
            console.error("[claude-host] WS message error:", e.message);
          }
        },
        () => {
          if (clientEntry) uiClients.delete(clientEntry);
        }
      );
      if (ws) {
        clientEntry = { ws, panelId };
        uiClients.add(clientEntry);
        // A reloaded WebView must still see questions that are waiting for an answer.
        for (const [promptId, entry] of pendingPrompts.entries()) {
          ws.sendJson({ __cc_host_event: "user_prompt", promptId, ...entry.payload });
        }
      }
      return;
    }
    socket.destroy();
  } catch (_) {
    socket.destroy();
  }
});

function shutdownHost() {
  for (const sess of Array.from(persistentPtys.values())) {
    try { sess.kill(); } catch (_) {}
  }
  try { server.close(); } catch (_) {}
  process.exit(0);
}
process.on("SIGTERM", shutdownHost);
process.on("SIGINT", shutdownHost);

(async () => {
  await bootExtensionHost();
  server.listen(args.port, args.host, () => {
    console.log(`[claude-host] listening on http://${args.host}:${args.port}/ (workspace: ${shim.getWorkspaceDirectory()})`);
  });
})();
