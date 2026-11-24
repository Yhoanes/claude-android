(function () {
  "use strict";

  if (window.__CC_ANDROID_BOOTED__) return;
  window.__CC_ANDROID_BOOTED__ = true;

  var BRIDGE_TOKEN = window.__CC_BRIDGE_TOKEN__ || "";
  try {
    delete window.__CC_BRIDGE_TOKEN__;
  } catch (e) {
    window.__CC_BRIDGE_TOKEN__ = undefined;
  }

  var INITIAL_THEME = window.__CC_HOST_THEME__ || "dark";
  var currentTheme = INITIAL_THEME === "light" ? "light" : "dark";
  var currentWorkspace = normalizeWsPath(window.__CC_INITIAL_WORKSPACE__ || "/storage/emulated/0/Documents/ClaudeCode");
  var activeChatSessionId = null;
  var collapsedWorkspaces = Object.create(null);
  var workspacesCollapsed = false;
  var searchBarOpen = false;
  var sidebarFilterQuery = "";
  var filesFilterQuery = "";
  var cachedWorkspacesData = null;
  var pendingCallbacks = Object.create(null);
  var cbCounter = 0;
  var suppressPopStateCount = 0;

  var DOCKED_BREAKPOINT = 680;
  var sidebarUserPref = null;
  try { sidebarUserPref = localStorage.getItem("cc_sidebar_open"); } catch (_) {}
  var sidebarOpen = sidebarUserPref !== null ? sidebarUserPref === "1" : (window.innerWidth >= DOCKED_BREAKPOINT);

  function normalizeWsPath(p) {
    var s = String(p || "").trim().replace(/\\/g, "/");
    if (!s) return "/storage/emulated/0/Documents/ClaudeCode";
    s = s.replace(/^\/sdcard(?=\/|$)/, "/storage/emulated/0");
    if (s.length > 1) s = s.replace(/\/+$/, "");
    return s || "/";
  }

  function nextCallbackId(prefix) {
    return (prefix || "cc_cb_") + (++cbCounter) + "_" + Date.now();
  }

  window.__ccOnPluginOpDone = function (cbId, resJson) {
    var fn = pendingCallbacks[cbId];
    if (fn) {
      delete pendingCallbacks[cbId];
      var parsed = {};
      try {
        parsed = typeof resJson === "string" ? JSON.parse(resJson) : (resJson || {});
      } catch (_) {}
      fn(parsed);
    }
  };

  window.__ccOnDirectoryPicked = function (cbId, pickedPath) {
    var fn = pendingCallbacks[cbId];
    if (fn) {
      delete pendingCallbacks[cbId];
      fn(pickedPath || "");
    }
  };

  var latestUpdateState = { type: "idle" };
  var activeUpdateRenderer = null;
  window.__ccOnUpdaterStateChanged = function (st) {
    latestUpdateState = st || { type: "idle" };
    if (typeof activeUpdateRenderer === "function") activeUpdateRenderer();
  };

  function getBridge() {
    return window.Android || window.AndroidBridge || null;
  }

  function applyResolvedTheme(mode) {
    currentTheme = mode === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-cc-theme", currentTheme);
    document.body.classList.remove("vscode-dark", "vscode-light");
    document.body.classList.add(currentTheme === "light" ? "vscode-light" : "vscode-dark");
    syncXtermTheme();
    var b = getBridge();
    if (b && typeof b.onVisualThemeChanged === "function") {
      try { b.onVisualThemeChanged(currentTheme); } catch (_) {}
    }
  }

  window.__agOnSystemThemeChanged = function () {
    if (window.__AG_RESOLVED_THEME__) {
      applyResolvedTheme(window.__AG_RESOLVED_THEME__);
    }
  };

  function apiGet(url) {
    return fetch(url, { credentials: "same-origin" }).then(function (r) { return r.json(); });
  }

  function apiPost(url, body) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function basename(p) {
    if (!p || p === "/") return "/";
    var clean = String(p).replace(/\/+$/, "");
    var idx = clean.lastIndexOf("/");
    return idx >= 0 ? clean.slice(idx + 1) : clean;
  }

  function popOverlayHistory() {
    suppressPopStateCount++;
    try {
      window.history.back();
    } catch (_) {
      suppressPopStateCount = Math.max(0, suppressPopStateCount - 1);
    }
  }

  function formatRelativeTime(ms) {
    if (!ms) return "";
    var diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diffSec < 60) return "now";
    var diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return diffMin + "m";
    var diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + "h";
    var diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return diffDay + "d";
    var d = new Date(ms);
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months[d.getMonth()] + " " + d.getDate();
  }

  // Dispatch native extension -> webview events directly into Anthropic's React store (0ms, no reload)
  function dispatchExtensionRequest(reqPayload) {
    window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      data: {
        type: "from-extension",
        message: {
          type: "request",
          channelId: "",
          requestId: "cc_local_" + (++cbCounter),
          request: reqPayload
        }
      }
    }));
  }

  // Official 1px/1.15px stroke monochrome SVGs matching Anthropic & Antigravity geometry
  var SVG = {
    sidebar20: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style="display:block"><rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" stroke="currentColor" stroke-width="1.15"/><path d="M7.5 3.75V16.25" stroke="currentColor" stroke-width="1.15"/></svg>',
    files20: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style="display:block"><path d="M5.25 3.25H11.5L15.25 7V16.75H5.25V3.25Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/><path d="M11.25 3.25V7.25H15.25" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/></svg>',
    terminal20: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" style="display:block"><rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" stroke="currentColor" stroke-width="1.15"/><path d="M6.25 7.75L8.75 10L6.25 12.25M10.25 12.25H13.5" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    search16: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.2"/><path d="M10.5 10.5L13.5 13.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    searchOfficial: '<svg class="searchIcon_OOQiHg" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.25"/><path d="M10.5 10.5L13.5 13.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
    plus15: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.25V12.75M3.25 8H12.75" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
    plus14: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.5V12.5M3.5 8H12.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
    dots14: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="3.5" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor"/></svg>',
    edit14: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.8 2.7L13.3 5.2L5.4 13.1H2.9V10.6L10.8 2.7Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    trash14: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.2 4.5H12.8M6.2 4.5V3.1H9.8V4.5M4.5 4.5L5.1 13.2H10.9L11.5 4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    at14: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="2.3" stroke="currentColor" stroke-width="1.2"/><path d="M10.3 8V9.1C10.3 10.1 11 10.7 11.8 10.7C12.8 10.7 13.5 9.6 13.5 8C13.5 4.9 11 2.5 8 2.5C4.9 2.5 2.5 4.9 2.5 8C2.5 11.1 4.9 13.5 8.2 13.5C9.4 13.5 10.4 13.2 11.2 12.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    newFolder15: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.25 4.25H6.2L7.4 5.45H13.75V12.75H2.25V4.25Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 7.25V10.75M6.25 9H9.75" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    refresh14: '<svg width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M12.6 8A4.6 4.6 0 1 1 11.3 4.8M12.6 3.1V5.6H10.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevOfficial: function (cls) {
      return '<svg class="' + cls + '" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4.5L9.5 8L6 11.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    },
    folder15: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true" style="flex-shrink:0"><path d="M2.75 5.25C2.75 4.42157 3.42157 3.75 4.25 3.75H7.68934C8.08716 3.75 8.4687 3.90804 8.75 4.18934L9.81066 5.25H15.75C16.5784 5.25 17.25 5.92157 17.25 6.75V14.75C17.25 15.5784 16.5784 16.25 15.75 16.25H4.25C3.42157 16.25 2.75 15.5784 2.75 14.75V5.25Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>',
    file14: '<svg width="13.5" height="13.5" viewBox="0 0 20 20" fill="none" aria-hidden="true" style="flex-shrink:0"><path d="M5.25 3.25H11.5L15.25 7V16.75H5.25V3.25Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M11.25 3.25V7.25H15.25" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    gear15: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true" style="flex-shrink:0"><circle cx="10" cy="10" r="2.6" stroke="currentColor" stroke-width="1.25"/><path d="M10 2.8V4.6M10 15.4V17.2M2.8 10H4.6M15.4 10H17.2M4.9 4.9L6.2 6.2M13.8 13.8L15.1 15.1M15.1 4.9L13.8 6.2M6.2 13.8L4.9 15.1" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
    terminal14: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true" style="flex-shrink:0"><rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" stroke="currentColor" stroke-width="1.25"/><path d="M6.25 7.75L8.75 10L6.25 12.25M10.25 12.25H13.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close16: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
    minimize16: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5H12.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
    maximize16: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 3.5H12.5V6.5M6.5 12.5H3.5V9.5M12.5 3.5L8.75 7.25M3.5 12.5L7.25 8.75" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    restore16: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M12.5 6.5H9.5V3.5M3.5 9.5H6.5V12.5M9.5 6.5L13 3M6.5 9.5L3 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    restart16: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M12.5 8A4.5 4.5 0 1 1 11.2 4.8M12.5 3.2V5.6H10.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    up16: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 12.5V3.5M8 3.5L4.5 7M8 3.5L11.5 7" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevRight16: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  function injectNativeStyles() {
    if (document.getElementById("cc-native-ext-styles")) return;
    var st = document.createElement("style");
    st.id = "cc-native-ext-styles";
    st.textContent = [
      ":root { --cc-dock-h: 42dvh; --cc-sb-w: 252px; }",
      /* Eliminate duplicate top-right Session History & New Session icons (they live in the official sidebar) */
      'body.cc-authed [class*="header_aqhumA"] button[aria-label="Session history"],',
      'body.cc-authed [class*="header_aqhumA"] button[aria-label="New session"] { display: none !important; }',
      /* Clean Antigravity-Style Official Left Sidebar */
      "#cc-sb-scrim { position: fixed; inset: 0; z-index: 7400; background: rgba(0, 0, 0, 0.42); display: none; }",
      "#cc-sidebar { position: fixed; top: 0; bottom: 0; left: 0; width: var(--cc-sb-w); z-index: 7500; display: none; border-right: 1px solid var(--app-primary-border-color); box-sizing: border-box; font-size: var(--vscode-chat-font-size, 13px); font-family: var(--vscode-chat-font-family); }",
      "body.cc-authed.cc-sb-open #cc-sidebar { display: flex; }",
      "@media (min-width: 680px) {",
      "  body.cc-authed.cc-sb-open #root { margin-left: var(--cc-sb-w) !important; width: calc(100% - var(--cc-sb-w)) !important; }",
      "  body.cc-authed.cc-sb-open #cc-term-dock { left: var(--cc-sb-w) !important; }",
      "}",
      "@media (max-width: 679px) {",
      "  body.cc-authed.cc-sb-open #cc-sb-scrim { display: block; }",
      "  #cc-sidebar { box-shadow: 8px 0 28px rgba(0, 0, 0, 0.45); }",
      "}",
      "#cc-sidebar .cc-sb-top { display: flex; align-items: center; justify-content: space-between; height: 41px; padding: 0 8px 0 14px; flex-shrink: 0; box-sizing: border-box; }",
      "#cc-sidebar .cc-sb-brand { font-size: 13.5px; font-weight: 600; color: var(--app-primary-foreground); letter-spacing: -0.01em; user-select: none; }",
      "#cc-sidebar .cc-sb-new-wrap { padding: 2px 10px 10px; flex-shrink: 0; }",
      "#cc-sidebar .cc-sb-new-pill { display: flex; align-items: center; gap: 8px; width: 100%; height: 34px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--app-primary-border-color); background: var(--app-secondary-background); color: var(--app-primary-foreground); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; box-sizing: border-box; }",
      "#cc-sidebar .cc-sb-new-pill:hover, #cc-sidebar .cc-sb-new-pill:active { background: var(--app-list-hover-background); }",
      "#cc-sidebar .cc-sb-search-wrap { display: none; padding: 0 10px 8px; flex-shrink: 0; }",
      "#cc-sidebar .cc-sb-search-wrap.open { display: block; }",
      "#cc-sidebar .cc-sb-search { width: 100%; box-sizing: border-box; height: 28px; padding: 4px 8px 4px 30px; border-radius: 6px; border: 1px solid var(--app-input-border); background: var(--app-input-background); color: var(--app-input-foreground); font: inherit; font-size: 12.5px; outline: none; }",
      "#cc-sidebar .cc-sb-search:focus { border-color: var(--app-input-active-border, var(--app-claude-orange)); }",
      "#cc-sidebar .cc-sb-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; min-height: 0; -webkit-overflow-scrolling: touch; padding-top: 2px; }",
      "#cc-sidebar .sectionHeader_djirOA { border-top: none; justify-content: space-between; padding: 0 6px 0 4px; flex-wrap: nowrap; height: 28px; }",
      "#cc-sidebar .sectionToggle_djirOA { flex: 1 1 auto; min-width: 0; }",
      "#cc-sidebar .sectionLabel_djirOA { text-transform: none; letter-spacing: 0; font-size: 12px; font-weight: 500; }",
      "#cc-sidebar .cc-ws-sessions { display: flex; flex-direction: column; gap: 1px; padding-left: 12px; margin: 1px 0 6px; }",
      "#cc-sidebar .cc-empty-note { padding: 4px 10px; font-size: 12px; color: var(--app-secondary-foreground); opacity: 0.55; user-select: none; }",
      "#cc-sidebar .groupHeader_OOQiHg { height: 28px; padding: 0 4px 0 8px; gap: 6px; }",
      "#cc-sidebar .groupHeader_OOQiHg.cc-ws-active .groupName_OOQiHg { color: var(--app-primary-foreground); }",
      "#cc-sidebar .cc-ws-folder-ico { display: inline-flex; color: var(--app-secondary-foreground); flex-shrink: 0; }",
      "#cc-sidebar .groupHeader_OOQiHg.cc-ws-active .cc-ws-folder-ico { color: var(--app-claude-orange, #d97757); }",
      ".cc-row-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: none; border-radius: 5px; background: transparent; color: var(--app-secondary-foreground); opacity: 0.65; cursor: pointer; flex-shrink: 0; }",
      ".cc-row-btn:hover, .cc-row-btn:active, .cc-row-btn.active { opacity: 1; color: var(--app-primary-foreground); background: var(--app-ghost-button-hover-background); }",
      "#cc-sidebar .sessionRowWrap { display: flex; align-items: center; border-radius: 6px; padding-right: 2px; min-width: 0; }",
      "#cc-sidebar .sessionRowWrap:hover { background: var(--app-list-hover-background); }",
      "#cc-sidebar .sessionRowWrap.active { background: var(--app-list-active-background); color: var(--app-list-active-foreground); }",
      "#cc-sidebar .sessionRowWrap .sessionItem_OOQiHg { flex: 1; min-width: 0; background: transparent !important; padding-right: 4px; height: 29px; }",
      "#cc-sidebar .sessionRowWrap.active .sessionName_OOQiHg { color: var(--app-list-active-foreground); font-weight: 500; }",
      "#cc-sidebar .cc-sb-footer { border-top: 1px solid var(--app-primary-border-color); padding: 6px 8px; flex-shrink: 0; }",
      "#cc-sidebar .cc-sb-foot-item { display: flex; align-items: center; gap: 9px; height: 32px; padding: 0 8px; border: none; border-radius: 6px; background: transparent; color: var(--app-secondary-foreground); font: inherit; font-size: 13px; cursor: pointer; text-align: left; width: 100%; }",
      "#cc-sidebar .cc-sb-foot-item:hover { background: var(--app-list-hover-background); color: var(--app-primary-foreground); }",
      /* Top-Right In-Chat Project Files Popover Drawer (Antigravity Overview -> Files style) */
      "#cc-files-popover { position: fixed; top: 44px; right: 10px; width: min(330px, calc(100vw - 20px)); max-height: min(74dvh, 560px); z-index: 8400; background: var(--app-menu-background, var(--app-primary-background)); color: var(--app-primary-foreground); border: 1px solid var(--app-primary-border-color); border-radius: 8px; box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5); display: none; flex-direction: column; overflow: hidden; font-family: var(--vscode-chat-font-family); font-size: 13px; }",
      "#cc-files-popover.open { display: flex; }",
      ".cc-fp-hdr { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 8px 8px 8px 12px; border-bottom: 1px solid var(--app-primary-border-color); background: var(--app-header-background); flex-shrink: 0; }",
      ".cc-fp-title { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 500; color: var(--app-primary-foreground); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".cc-fp-search-row { padding: 6px 8px; border-bottom: 1px solid var(--app-primary-border-color); flex-shrink: 0; }",
      ".cc-fp-body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 4px 6px 8px; -webkit-overflow-scrolling: touch; min-height: 90px; }",
      ".cc-file-row { display: flex; align-items: center; border-radius: 5px; height: 28px; padding-right: 2px; min-width: 0; }",
      ".cc-file-row:hover { background: var(--app-list-hover-background); }",
      ".cc-file-main { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; height: 100%; border: none; background: transparent; color: var(--app-primary-foreground); font: inherit; font-size: 12.5px; text-align: left; cursor: pointer; padding: 0 4px 0 6px; }",
      ".cc-file-ico { display: inline-flex; color: var(--app-secondary-foreground); flex-shrink: 0; }",
      ".cc-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }",
      /* Floating Context Menu */
      "#cc-ctx-menu { position: fixed; z-index: 9600; min-width: 176px; max-width: 240px; padding: 4px; border-radius: 6px; background: var(--app-menu-background, var(--app-secondary-background)); color: var(--app-menu-foreground, var(--app-primary-foreground)); border: 1px solid var(--app-menu-border, var(--app-primary-border-color)); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); display: none; flex-direction: column; gap: 1px; font-family: var(--vscode-chat-font-family); font-size: 12.5px; }",
      "#cc-ctx-menu.open { display: flex; }",
      ".cc-ctx-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: none; border-radius: 4px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; box-sizing: border-box; }",
      ".cc-ctx-item:hover, .cc-ctx-item:active { background: var(--app-list-hover-background); }",
      ".cc-ctx-item.danger { color: var(--app-diff-deletion-foreground, #ef6b6b); }",
      ".cc-ctx-sep { height: 1px; margin: 3px 4px; background: var(--app-primary-border-color); }",
      /* Per-Project Persistent Bottom Docked Terminal */
      "body.cc-term-dock-open #root { height: calc(100% - var(--cc-dock-h)) !important; }",
      "body.cc-term-dock-full #root { display: none !important; }",
      ".iconButton_YKLzCw.cc-term-running, .iconButton_YKLzCw.cc-panel-active { color: var(--app-claude-orange, #d97757); }",
      "#cc-term-dock { position: fixed; left: 0; right: 0; bottom: 0; height: var(--cc-dock-h); z-index: 8000; display: none; flex-direction: column; background: var(--app-primary-background); border-top: 1px solid var(--app-primary-border-color); box-sizing: border-box; }",
      "body.cc-term-dock-open #cc-term-dock { display: flex; }",
      "body.cc-term-dock-full #cc-term-dock { height: 100% !important; left: 0 !important; z-index: 8600; border-top: none; }",
      ".cc-dock-bar { display: flex; align-items: center; justify-content: space-between; height: 32px; padding: 0 6px 0 12px; background: var(--app-header-background); border-bottom: 1px solid var(--app-primary-border-color); user-select: none; flex-shrink: 0; }",
      ".cc-dock-title { display: inline-flex; align-items: center; gap: 7px; font-family: var(--vscode-chat-font-family); font-size: 12px; font-weight: 500; color: var(--app-secondary-foreground); }",
      ".cc-dock-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--app-secondary-foreground); opacity: 0.45; }",
      ".cc-dock-dot.live { background: #74c991; opacity: 1; }",
      ".cc-dock-actions { display: inline-flex; align-items: center; gap: 2px; }",
      "#cc-xterm-host { flex: 1; min-height: 0; width: 100%; padding: 4px 8px 2px; box-sizing: border-box; overflow: hidden; }",
      "#cc-xterm-host .xterm { height: 100%; }",
      "#cc-xterm-host .xterm-viewport { overflow-y: auto !important; -webkit-overflow-scrolling: touch; }",
      ".cc-term-keybar { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-top: 1px solid var(--app-primary-border-color); background: var(--app-header-background); overflow-x: auto; scrollbar-width: none; flex-shrink: 0; }",
      ".cc-term-keybar::-webkit-scrollbar { display: none; }",
      ".cc-tkey { flex-shrink: 0; background: var(--app-input-background); color: var(--app-secondary-foreground); border: 1px solid var(--app-input-border); border-radius: 3px; font-family: var(--app-monospace-font-family, monospace); font-size: 11px; line-height: 1; padding: 5px 8px; cursor: pointer; user-select: none; }",
      ".cc-tkey:active, .cc-tkey:hover { color: var(--app-primary-foreground); border-color: var(--app-claude-orange, #d97757); }",
      /* Native Dialogs & File Editor */
      "#cc-dialog-backdrop { position: fixed; inset: 0; z-index: 9000; background: rgba(0, 0, 0, 0.52); display: none; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }",
      "#cc-dialog-backdrop.open { display: flex; }",
      "#cc-dialog-box { width: 100%; max-width: 580px; max-height: min(86dvh, 700px); background: var(--app-primary-background); color: var(--app-primary-foreground); border: 1px solid var(--app-primary-border-color); border-radius: 6px; box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45); display: flex; flex-direction: column; overflow: hidden; font-family: var(--vscode-chat-font-family); font-size: 13px; }",
      ".cc-dlg-hdr { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--app-primary-border-color); background: var(--app-header-background); }",
      ".cc-dlg-title { font-size: 13px; font-weight: 500; color: var(--app-primary-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".cc-dlg-body { flex: 1; overflow-y: auto; padding: 14px; -webkit-overflow-scrolling: touch; }",
      ".cc-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--app-primary-border-color); margin: -14px -14px 14px -14px; padding: 0 12px; background: var(--app-header-background); overflow-x: auto; scrollbar-width: none; }",
      ".cc-tabs::-webkit-scrollbar { display: none; }",
      ".cc-tab { background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--app-secondary-foreground); font: inherit; font-size: 12.5px; font-weight: 500; padding: 9px 10px 8px; cursor: pointer; white-space: nowrap; }",
      ".cc-tab:hover { color: var(--app-primary-foreground); }",
      ".cc-tab.active { color: var(--app-primary-foreground); border-bottom-color: var(--app-claude-orange, #d97757); }",
      ".cc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-family: inherit; font-size: 12.5px; font-weight: 500; padding: 6px 11px; border-radius: 4px; border: 1px solid var(--app-transparent-inner-border, var(--app-input-border)); background: var(--app-input-background); color: var(--app-primary-foreground); cursor: pointer; }",
      ".cc-btn:hover:not(:disabled) { filter: brightness(1.08); }",
      ".cc-btn:disabled { opacity: 0.55; cursor: default; }",
      ".cc-btn.primary { background: var(--app-claude-clay-button-orange, #d97757); border-color: transparent; color: #fff; }",
      ".cc-btn.danger { background: #c93c37; border-color: transparent; color: #fff; }",
      ".cc-input { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--app-input-border); background: var(--app-input-background); color: var(--app-input-foreground); outline: none; }",
      ".cc-input:focus { border-color: var(--app-claude-orange, #d97757); }",
      ".cc-editor-area { width: 100%; min-height: 300px; box-sizing: border-box; padding: 10px; border-radius: 4px; border: 1px solid var(--app-input-border); background: var(--app-code-background, var(--app-input-background)); color: var(--app-primary-foreground); font-family: var(--app-monospace-font-family, monospace); font-size: 12px; line-height: 1.45; resize: vertical; outline: none; }",
      ".cc-editor-area:focus { border-color: var(--app-claude-orange, #d97757); }",
      ".cc-label { display: block; font-size: 12px; color: var(--app-secondary-foreground); margin-bottom: 4px; }",
      ".cc-row-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: 4px; cursor: pointer; color: var(--app-primary-foreground); }",
      ".cc-row-item:hover { background: var(--app-ghost-button-hover-background); }",
      ".cc-card { border: 1px solid var(--app-primary-border-color); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; background: var(--app-secondary-background); }",
      ".cc-pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--app-input-border); background: transparent; color: var(--app-secondary-foreground); font: inherit; font-size: 11.5px; cursor: pointer; }",
      ".cc-pill:hover, .cc-pill.active { color: var(--app-primary-foreground); background: var(--app-ghost-button-hover-background); border-color: var(--app-claude-orange, #d97757); }",
      "#cc-toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 9500; background: var(--app-menu-background); color: var(--app-menu-foreground); border: 1px solid var(--app-menu-border); border-radius: 4px; padding: 7px 12px; font-size: 12.5px; box-shadow: 0 4px 16px rgba(0,0,0,0.4); opacity: 0; pointer-events: none; transition: opacity 0.16s ease; }",
      "#cc-toast.visible { opacity: 1; }"
    ].join("\n");
    document.head.appendChild(st);
  }

  var toastEl = null;
  var toastTimer = null;
  function showToast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "cc-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("visible");
    }, 2600);
  }

  // ---------------------------------------------------------------------------
  // Floating Native Context Menu (#cc-ctx-menu)
  // ---------------------------------------------------------------------------
  var ctxMenuEl = null;

  function closeContextMenu() {
    if (ctxMenuEl && ctxMenuEl.classList.contains("open")) {
      ctxMenuEl.classList.remove("open");
      ctxMenuEl.innerHTML = "";
    }
  }

  function showContextMenu(anchorEl, items) {
    if (!ctxMenuEl) {
      ctxMenuEl = document.createElement("div");
      ctxMenuEl.id = "cc-ctx-menu";
      document.body.appendChild(ctxMenuEl);
      document.addEventListener("pointerdown", function (ev) {
        if (ctxMenuEl && ctxMenuEl.classList.contains("open") && !ctxMenuEl.contains(ev.target)) {
          closeContextMenu();
        }
      }, true);
      document.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") closeContextMenu();
      });
    }

    ctxMenuEl.innerHTML = "";
    items.forEach(function (it) {
      if (it.separator) {
        var sep = document.createElement("div");
        sep.className = "cc-ctx-sep";
        ctxMenuEl.appendChild(sep);
        return;
      }
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cc-ctx-item" + (it.danger ? " danger" : "");
      btn.innerHTML = (it.icon || "") + "<span>" + escapeHtml(it.label) + "</span>";
      btn.onclick = function (ev) {
        ev.stopPropagation();
        closeContextMenu();
        if (typeof it.onClick === "function") it.onClick();
      };
      ctxMenuEl.appendChild(btn);
    });

    ctxMenuEl.style.left = "8px";
    ctxMenuEl.style.top = "8px";
    ctxMenuEl.classList.add("open");

    var rect = anchorEl.getBoundingClientRect();
    var mRect = ctxMenuEl.getBoundingClientRect();
    var left = rect.left;
    var top = rect.bottom + 4;
    if (left + mRect.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - mRect.width - 8);
    }
    if (top + mRect.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - mRect.height - 4);
    }
    ctxMenuEl.style.left = Math.round(left) + "px";
    ctxMenuEl.style.top = Math.round(top) + "px";
  }

  // ---------------------------------------------------------------------------
  // Modal Dialog + Native Prompt & Confirm Modals
  // ---------------------------------------------------------------------------
  var backdropEl = null;
  var dlgBoxEl = null;
  var dlgTitleEl = null;
  var dlgHdrRightEl = null;
  var dlgBodyEl = null;
  var onCloseCleanup = null;

  function ensureDialogDom() {
    if (backdropEl) return;
    backdropEl = document.createElement("div");
    backdropEl.id = "cc-dialog-backdrop";
    backdropEl.onclick = function (ev) {
      if (ev.target === backdropEl) closeDialog();
    };
    dlgBoxEl = document.createElement("div");
    dlgBoxEl.id = "cc-dialog-box";
    var hdr = document.createElement("div");
    hdr.className = "cc-dlg-hdr";
    dlgTitleEl = document.createElement("div");
    dlgTitleEl.className = "cc-dlg-title";
    var rightWrap = document.createElement("div");
    rightWrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;flex-shrink:0;";
    dlgHdrRightEl = document.createElement("div");
    dlgHdrRightEl.style.cssText = "display:inline-flex;align-items:center;gap:6px;";
    var cls = document.createElement("button");
    cls.type = "button";
    cls.className = "iconButton_YKLzCw iconButton16_YKLzCw";
    cls.setAttribute("aria-label", "Close dialog");
    cls.innerHTML = SVG.close16;
    cls.onclick = function () { closeDialog(); };
    rightWrap.appendChild(dlgHdrRightEl);
    rightWrap.appendChild(cls);
    hdr.appendChild(dlgTitleEl);
    hdr.appendChild(rightWrap);
    dlgBodyEl = document.createElement("div");
    dlgBodyEl.className = "cc-dlg-body";
    dlgBoxEl.appendChild(hdr);
    dlgBoxEl.appendChild(dlgBodyEl);
    backdropEl.appendChild(dlgBoxEl);
    document.body.appendChild(backdropEl);
  }

  function openDialog(title, renderFn, cleanupFn, maxWidthPx) {
    ensureDialogDom();
    closeContextMenu();
    var wasOpen = backdropEl.classList.contains("open");
    if (onCloseCleanup) {
      try { onCloseCleanup(); } catch (_) {}
      onCloseCleanup = null;
    }
    dlgBoxEl.style.maxWidth = (maxWidthPx || 580) + "px";
    dlgTitleEl.textContent = title;
    dlgHdrRightEl.innerHTML = "";
    dlgBodyEl.innerHTML = "";
    onCloseCleanup = cleanupFn || null;
    renderFn(dlgBodyEl, dlgHdrRightEl);
    backdropEl.classList.add("open");
    if (!wasOpen) {
      var curHash = window.location.hash;
      var filesClosed = !filesPopoverEl || !filesPopoverEl.classList.contains("open");
      var sbOverlayClosed = !(window.innerWidth < DOCKED_BREAKPOINT && sidebarOpen);
      if (
        curHash === "#dialog" ||
        (curHash === "#files" && filesClosed) ||
        (curHash === "#sidebar" && sbOverlayClosed)
      ) {
        try { window.history.replaceState({ ccDlg: true }, "", "#dialog"); } catch (_) {}
      } else {
        try { window.history.pushState({ ccDlg: true }, "", "#dialog"); } catch (_) {}
      }
    }
  }

  function closeDialog(skipHistoryBack) {
    if (!backdropEl || !backdropEl.classList.contains("open")) return;
    backdropEl.classList.remove("open");
    activeUpdateRenderer = null;
    if (onCloseCleanup) {
      var fn = onCloseCleanup;
      onCloseCleanup = null;
      try { fn(); } catch (_) {}
    }
    if (skipHistoryBack !== true && window.location.hash === "#dialog") {
      popOverlayHistory();
    }
  }

  function openPromptModal(opts) {
    openDialog(opts.title || "Input", function (container) {
      if (opts.label) {
        var lbl = document.createElement("label");
        lbl.className = "cc-label";
        lbl.textContent = opts.label;
        container.appendChild(lbl);
      }
      var inp = document.createElement("input");
      inp.type = "text";
      inp.className = "cc-input";
      inp.value = opts.initialValue || "";
      inp.placeholder = opts.placeholder || "";
      inp.style.marginBottom = "14px";
      container.appendChild(inp);

      var actions = document.createElement("div");
      actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
      var cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "cc-btn";
      cancelBtn.textContent = "Cancel";
      cancelBtn.onclick = function () { closeDialog(); };

      var okBtn = document.createElement("button");
      okBtn.type = "button";
      okBtn.className = "cc-btn primary";
      okBtn.textContent = opts.confirmLabel || "Save";

      function submit() {
        var v = inp.value.trim();
        if (!v) {
          inp.focus();
          return;
        }
        closeDialog();
        if (typeof opts.onConfirm === "function") opts.onConfirm(v);
      }

      okBtn.onclick = submit;
      inp.onkeydown = function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      };

      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      container.appendChild(actions);

      setTimeout(function () {
        inp.focus();
        inp.select();
      }, 30);
    }, null, 400);
  }

  function openConfirmModal(opts) {
    openDialog(opts.title || "Confirm", function (container) {
      var msg = document.createElement("div");
      msg.style.cssText = "font-size:13px;line-height:1.45;color:var(--app-primary-foreground);margin-bottom:16px;word-break:break-word;";
      msg.textContent = opts.message || "Are you sure?";
      container.appendChild(msg);

      var actions = document.createElement("div");
      actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
      var cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "cc-btn";
      cancelBtn.textContent = "Cancel";
      cancelBtn.onclick = function () { closeDialog(); };

      var okBtn = document.createElement("button");
      okBtn.type = "button";
      okBtn.className = "cc-btn " + (opts.danger ? "danger" : "primary");
      okBtn.textContent = opts.confirmLabel || "Confirm";
      okBtn.onclick = function () {
        closeDialog();
        if (typeof opts.onConfirm === "function") opts.onConfirm();
      };

      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      container.appendChild(actions);
    }, null, 400);
  }

  window.addEventListener("popstate", function () {
    if (suppressPopStateCount > 0) {
      suppressPopStateCount--;
      return;
    }
    closeContextMenu();
    if (backdropEl && backdropEl.classList.contains("open")) {
      closeDialog(true);
    } else if (filesPopoverEl && filesPopoverEl.classList.contains("open")) {
      closeFilesPopover(true);
    } else if (document.body.classList.contains("cc-term-dock-open")) {
      hideTerminalDock(true);
    } else if (window.innerWidth < DOCKED_BREAKPOINT && sidebarOpen) {
      setSidebarOpen(false, true);
    }
  });

  // ---------------------------------------------------------------------------
  // A. Seamless Pre-Login API Key Option (Inside Anthropic's .methodSelection_Eg8KCQ)
  // ---------------------------------------------------------------------------
  // The API key is encrypted by Android (Keystore) and only kept in memory by the host.
  // Returns false only when the device could not store it securely.
  function persistApiKeySecurely(key) {
    var b = getBridge();
    if (!b || typeof b.storeApiKeyAuth !== "function" || !BRIDGE_TOKEN) return true;
    try {
      return b.storeApiKeyAuth(BRIDGE_TOKEN, key) === true;
    } catch (_) {
      return false;
    }
  }

  function clearStoredApiKey() {
    var b = getBridge();
    if (b && typeof b.clearApiKeyAuth === "function" && BRIDGE_TOKEN) {
      try { b.clearApiKeyAuth(BRIDGE_TOKEN); } catch (_) {}
    }
  }

  function navigateAfterAuthChange(res) {
    var nextPanel = res && (res.activePanelId || (res.auth && res.auth.activePanelId));
    if (nextPanel) {
      window.location.href = "/?panel=" + encodeURIComponent(nextPanel) + "&theme=" + encodeURIComponent(currentTheme);
    } else {
      window.location.href = "/?theme=" + encodeURIComponent(currentTheme);
    }
  }

  function syncLoginScreenOption() {
    var methodList = document.querySelector('[class*="methodSelection_"]');
    if (!methodList) return;
    document.body.classList.remove("cc-authed", "cc-term-dock-open", "cc-term-dock-full");
    closeFilesPopover(true);
    if (methodList.querySelector("[data-cc-apikey-entry]")) return;

    var wrap = document.createElement("div");
    wrap.setAttribute("data-cc-apikey-entry", "1");

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fullWidthButton_Eg8KCQ";
    btn.textContent = "API Key";

    var note = document.createElement("p");
    note.className = "noteBeneathButton_Eg8KCQ";
    note.textContent = "Sign in directly with an Anthropic API key or compatible endpoint.";

    var formWrap = document.createElement("div");
    formWrap.style.cssText = "display:none;margin-top:10px;padding:12px;border:1px solid var(--app-input-border);border-radius:4px;background:var(--app-secondary-background);";

    var keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.className = "codeInput_Eg8KCQ";
    keyInput.placeholder = "sk-ant-api03-...";
    keyInput.style.marginBottom = "8px";

    var urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "codeInput_Eg8KCQ";
    urlInput.placeholder = "Custom Base URL (optional, e.g. https://openrouter.ai/api)";
    urlInput.style.marginBottom = "8px";

    var submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "fullWidthButton_Eg8KCQ primary_Eg8KCQ";
    submitBtn.textContent = "Continue with API Key";
    submitBtn.onclick = function () {
      var k = keyInput.value.trim();
      if (!k) {
        keyInput.focus();
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = "Connecting...";
      if (!persistApiKeySecurely(k)) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Continue with API Key";
        showToast("Could not store the API key securely on this device");
        return;
      }
      apiPost("/api/auth/config", {
        apiKey: k,
        baseUrl: urlInput.value.trim()
      }).then(function (res) {
        navigateAfterAuthChange(res);
      }).catch(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = "Continue with API Key";
      });
    };

    formWrap.appendChild(keyInput);
    formWrap.appendChild(urlInput);
    formWrap.appendChild(submitBtn);

    btn.onclick = function () {
      var hidden = formWrap.style.display === "none";
      formWrap.style.display = hidden ? "block" : "none";
      if (hidden) keyInput.focus();
    };

    wrap.appendChild(btn);
    wrap.appendChild(note);
    wrap.appendChild(formWrap);
    methodList.appendChild(wrap);
  }

  // ---------------------------------------------------------------------------
  // B. Antigravity-Style Clean Left Sidebar (Projects & Conversations ONLY + Settings)
  // ---------------------------------------------------------------------------
  var sidebarEl = null;
  var scrimEl = null;
  var sbListEl = null;
  var sbSecChevHolder = null;
  var sbBodyWrap = null;
  var sbSearchWrap = null;
  var sbSearchInput = null;
  var sbSearchToggleBtn = null;
  var hdrSidebarBtn = null;
  var hdrFilesBtn = null;
  var hdrTermBtn = null;
  var dockFolderSpan = null;
  var refreshTreeTimer = null;
  var sidebarDataHydrated = false;

  function getLiveSessionId() {
    try {
      var panelId = window.__CC_PANEL_ID__ || "panel-1";
      var raw = sessionStorage.getItem("__cc_vscode_state_" + panelId);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed.sessionID === "string" && parsed.sessionID) {
          return parsed.sessionID;
        }
      }
    } catch (_) {}
    return activeChatSessionId || "";
  }

  function formatBytes(n) {
    var b = Number(n) || 0;
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + " KB";
    return (b / (1024 * 1024)).toFixed(1) + " MB";
  }

  function setWorkspaceLabel(ws) {
    if (ws) currentWorkspace = normalizeWsPath(ws);
    if (dockFolderSpan) dockFolderSpan.textContent = "Terminal · " + basename(currentWorkspace);
  }

  function setSidebarOpen(open, skipHistoryBack) {
    var nextOpen = !!open;
    var wasOpen = sidebarOpen;
    sidebarOpen = nextOpen;
    document.body.classList.toggle("cc-sb-open", sidebarOpen);
    try { localStorage.setItem("cc_sidebar_open", sidebarOpen ? "1" : "0"); } catch (_) {}
    if (window.innerWidth < DOCKED_BREAKPOINT && nextOpen !== wasOpen) {
      if (nextOpen) {
        try { window.history.pushState({ ccSb: true }, "", "#sidebar"); } catch (_) {}
      } else if (skipHistoryBack !== true && window.location.hash === "#sidebar") {
        popOverlayHistory();
      }
    }
    if (sidebarOpen) {
      refreshSidebarTree();
    }
    setTimeout(fitAndNotifyPty, 60);
  }

  function toggleSidebar() {
    setSidebarOpen(!sidebarOpen);
  }

  function closeSidebarIfMobileOverlay(skipHistoryBack) {
    if (window.innerWidth < DOCKED_BREAKPOINT && sidebarOpen) {
      setSidebarOpen(false, skipHistoryBack);
    }
  }

  function startNewChatInCurrentWorkspace() {
    activeChatSessionId = null;
    dispatchExtensionRequest({ type: "create_new_conversation" });
    closeSidebarIfMobileOverlay();
    renderWorkspacesTreeDom();
    if (filesPopoverEl && filesPopoverEl.classList.contains("open")) {
      cachedSessionFiles = [];
      renderFilesTreeDom();
    }
    scheduleSidebarRefresh(600);
  }

  function openChatSession(wsPath, sessionId) {
    activeChatSessionId = sessionId;
    if (normalizeWsPath(wsPath) === currentWorkspace) {
      dispatchExtensionRequest({ type: "activate_session", sessionId: sessionId });
      closeSidebarIfMobileOverlay();
      renderWorkspacesTreeDom();
      if (filesPopoverEl && filesPopoverEl.classList.contains("open")) {
        setTimeout(refreshFilesTree, 80);
      }
      return;
    }
    selectAndSwitchWorkspace(wsPath, sessionId);
  }

  function promptRenameChatSession(sessionObj) {
    openPromptModal({
      title: "Rename Session",
      label: "Session title",
      initialValue: sessionObj.title || "",
      confirmLabel: "Rename",
      onConfirm: function (newTitle) {
        apiPost("/api/sessions/rename", { sessionId: sessionObj.id, title: newTitle }).then(function (r) {
          if (r && r.ok) {
            sessionObj.title = r.title;
            dispatchExtensionRequest({ type: "session_renamed", sessionId: sessionObj.id, title: r.title });
            renderWorkspacesTreeDom();
            showToast("Session renamed");
          } else {
            showToast((r && r.error) || "Could not rename session");
          }
        });
      }
    });
  }

  function promptDeleteChatSession(sessionObj) {
    openConfirmModal({
      title: "Delete Session",
      message: 'Delete "' + (sessionObj.title || "Untitled") + '" permanently?',
      confirmLabel: "Delete",
      danger: true,
      onConfirm: function () {
        apiPost("/api/sessions/delete", { sessionId: sessionObj.id }).then(function (r) {
          if (r && r.ok) {
            if (getLiveSessionId() === sessionObj.id || activeChatSessionId === sessionObj.id) {
              activeChatSessionId = null;
              dispatchExtensionRequest({ type: "create_new_conversation" });
            }
            refreshSidebarTree();
            showToast("Session deleted");
          } else {
            showToast((r && r.error) || "Could not delete session");
          }
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // In-Chat Top-Right Session Files Popover (#cc-files-popover — Option A: Session Only)
  // ---------------------------------------------------------------------------
  var filesPopoverEl = null;
  var fpSearchRowEl = null;
  var fpBodyEl = null;
  var cachedSessionFiles = null;

  function isImagePath(p) {
    return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(String(p || ""));
  }

  function isBinaryFilePath(p) {
    return /\.(pdf|docx?|xlsx?|pptx?|zip|tar|gz|xz|zst|7z|rar|apk|aab|dex|so|elf|o|a|mp4|mkv|webm|mp3|wav|ogg|m4a|flac|ttf|otf|woff2?|sqlite3?|db)$/i.test(String(p || ""));
  }

  function insertFileMentionInChat(fullPath) {
    var normWs = normalizeWsPath(currentWorkspace);
    var normFile = normalizeWsPath(fullPath);
    var rel = normFile;
    if (normFile.indexOf(normWs + "/") === 0) {
      rel = normFile.slice(normWs.length + 1);
    }
    dispatchExtensionRequest({ type: "insert_at_mention", text: rel });
    closeFilesPopover();
    showToast("Inserted @" + basename(fullPath));
  }

  function openProjectFileItem(item) {
    closeFilesPopover(true);
    if (isImagePath(item.path)) {
      openDialog(item.name, function (container) {
        var wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:10px;";
        var img = document.createElement("img");
        img.src = "/api/fs/raw?path=" + encodeURIComponent(item.path) + "&t=" + Date.now();
        img.style.cssText = "max-width:100%;max-height:62dvh;object-fit:contain;border-radius:4px;border:1px solid var(--app-primary-border-color);";
        wrap.appendChild(img);
        container.appendChild(wrap);
      });
      return;
    }
    if (isBinaryFilePath(item.path)) {
      openDialog(item.name, function (container) {
        var card = document.createElement("div");
        card.className = "cc-card";
        card.innerHTML =
          '<div style="font-weight:500;margin-bottom:4px">' + escapeHtml(item.name) + "</div>" +
          '<div style="font-family:var(--app-monospace-font-family,monospace);font-size:11.5px;color:var(--app-secondary-foreground);word-break:break-all;margin-bottom:6px">' + escapeHtml(item.path) + "</div>" +
          '<div style="font-size:12px;color:var(--app-secondary-foreground)">Size: ' + escapeHtml(formatBytes(item.size)) + "</div>";
        container.appendChild(card);

        var row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;";
        var mBtn = document.createElement("button");
        mBtn.type = "button";
        mBtn.className = "cc-btn primary";
        mBtn.textContent = "Mention in chat (@)";
        mBtn.onclick = function () {
          closeDialog();
          insertFileMentionInChat(item.path);
        };
        var rBtn = document.createElement("button");
        rBtn.type = "button";
        rBtn.className = "cc-btn";
        rBtn.textContent = "Rename";
        rBtn.onclick = function () { promptRenameFsEntry(item); };
        var dBtn = document.createElement("button");
        dBtn.type = "button";
        dBtn.className = "cc-btn danger";
        dBtn.textContent = "Delete";
        dBtn.onclick = function () { promptDeleteFsEntry(item); };
        row.appendChild(mBtn);
        row.appendChild(rBtn);
        row.appendChild(dBtn);
        container.appendChild(row);
      }, null, 420);
      return;
    }
    openFileEditorDialog(item.path, null, item.name, function () {
      refreshFilesTree();
    });
  }

  function promptRenameFsEntry(item) {
    closeFilesPopover(true);
    openPromptModal({
      title: "Rename File",
      label: "New file name",
      initialValue: item.name,
      confirmLabel: "Rename",
      onConfirm: function (newName) {
        if (newName === item.name) return;
        apiPost("/api/fs/rename", { targetPath: item.path, newName: newName }).then(function (r) {
          if (r && r.ok) {
            refreshFilesTree();
            showToast("Renamed to " + r.name);
          } else {
            showToast((r && r.error) || "Rename failed");
          }
        });
      }
    });
  }

  function promptDeleteFsEntry(item) {
    closeFilesPopover(true);
    openConfirmModal({
      title: "Delete File",
      message: 'Delete "' + item.name + '" permanently?',
      confirmLabel: "Delete",
      danger: true,
      onConfirm: function () {
        apiPost("/api/fs/delete", { targetPath: item.path }).then(function (r) {
          if (r && r.ok) {
            refreshFilesTree();
            showToast("Deleted " + item.name);
          } else {
            showToast((r && r.error) || "Delete failed");
          }
        });
      }
    });
  }

  function refreshFilesTree() {
    var sid = getLiveSessionId();
    if (!sid) {
      cachedSessionFiles = [];
      renderFilesTreeDom();
      return;
    }
    apiGet("/api/sessions/files?sessionId=" + encodeURIComponent(sid)).then(function (data) {
      cachedSessionFiles = (data && Array.isArray(data.files)) ? data.files : [];
      renderFilesTreeDom();
    }).catch(function () {
      cachedSessionFiles = [];
      renderFilesTreeDom();
    });
  }

  function renderFilesTreeDom() {
    if (!fpBodyEl) return;
    fpBodyEl.innerHTML = "";

    if (cachedSessionFiles === null) {
      var loading = document.createElement("div");
      loading.style.cssText = "padding:14px 10px;font-size:12px;color:var(--app-secondary-foreground);opacity:0.7;text-align:center;";
      loading.textContent = "Loading session files…";
      fpBodyEl.appendChild(loading);
      return;
    }

    if (fpSearchRowEl) {
      fpSearchRowEl.style.display = cachedSessionFiles.length >= 6 ? "block" : "none";
    }

    var q = cachedSessionFiles.length >= 6 ? filesFilterQuery : "";
    var list = q
      ? cachedSessionFiles.filter(function (it) { return it.name.toLowerCase().indexOf(q) !== -1; })
      : cachedSessionFiles;

    if (list.length === 0) {
      var empty = document.createElement("div");
      empty.style.cssText = "padding:18px 14px;text-align:center;";
      empty.innerHTML =
        '<div style="font-size:12.5px;color:var(--app-secondary-foreground);margin-bottom:4px">' +
        (q ? "No matching files" : "No files in this session yet") +
        "</div>" +
        (q ? "" : '<div style="font-size:11.5px;color:var(--app-secondary-foreground);opacity:0.65;line-height:1.4">Files created or edited in this chat will appear here.</div>');
      fpBodyEl.appendChild(empty);
      return;
    }

    list.forEach(function (it) {
      var row = document.createElement("div");
      row.className = "cc-file-row";

      var mainBtn = document.createElement("button");
      mainBtn.type = "button";
      mainBtn.className = "cc-file-main";
      mainBtn.title = it.path;
      mainBtn.innerHTML =
        '<span class="cc-file-ico">' + SVG.file14 + "</span>" +
        '<span class="cc-file-name">' + escapeHtml(it.name) + "</span>" +
        '<span style="font-size:11px;color:var(--app-secondary-foreground);opacity:0.65;flex-shrink:0">' + escapeHtml(formatBytes(it.size)) + "</span>";
      mainBtn.onclick = function () {
        openProjectFileItem(it);
      };

      var moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "cc-row-btn";
      moreBtn.title = "File actions";
      moreBtn.innerHTML = SVG.dots14;
      moreBtn.onclick = function (ev) {
        ev.stopPropagation();
        var menuItems = [
          {
            label: "Mention in chat (@)",
            icon: SVG.at14,
            onClick: function () { insertFileMentionInChat(it.path); }
          }
        ];
        if (!isImagePath(it.path) && !isBinaryFilePath(it.path)) {
          menuItems.push({
            label: "Edit file",
            icon: SVG.edit14,
            onClick: function () { openProjectFileItem(it); }
          });
        }
        menuItems.push({ separator: true });
        menuItems.push({
          label: "Rename…",
          icon: SVG.edit14,
          onClick: function () { promptRenameFsEntry(it); }
        });
        menuItems.push({
          label: "Delete…",
          icon: SVG.trash14,
          danger: true,
          onClick: function () { promptDeleteFsEntry(it); }
        });
        showContextMenu(moreBtn, menuItems);
      };

      row.appendChild(mainBtn);
      row.appendChild(moreBtn);
      fpBodyEl.appendChild(row);
    });
  }

  function ensureFilesPopoverDom() {
    if (filesPopoverEl) return;
    filesPopoverEl = document.createElement("div");
    filesPopoverEl.id = "cc-files-popover";

    var hdr = document.createElement("div");
    hdr.className = "cc-fp-hdr";

    var titleWrap = document.createElement("div");
    titleWrap.className = "cc-fp-title";
    titleWrap.innerHTML = SVG.file14 + "<span>Session files</span>";

    var actRow = document.createElement("div");
    actRow.style.cssText = "display:inline-flex;align-items:center;gap:2px;flex-shrink:0;";

    var rfBtn = document.createElement("button");
    rfBtn.type = "button";
    rfBtn.className = "cc-row-btn";
    rfBtn.title = "Refresh";
    rfBtn.innerHTML = SVG.refresh14;
    rfBtn.onclick = function () { refreshFilesTree(); };

    var clBtn = document.createElement("button");
    clBtn.type = "button";
    clBtn.className = "cc-row-btn";
    clBtn.title = "Close";
    clBtn.innerHTML = SVG.close16;
    clBtn.onclick = function () { closeFilesPopover(); };

    actRow.appendChild(rfBtn);
    actRow.appendChild(clBtn);

    hdr.appendChild(titleWrap);
    hdr.appendChild(actRow);
    filesPopoverEl.appendChild(hdr);

    fpSearchRowEl = document.createElement("div");
    fpSearchRowEl.className = "cc-fp-search-row";
    fpSearchRowEl.style.display = "none";
    var sBox = document.createElement("div");
    sBox.className = "searchBox_OOQiHg";
    sBox.innerHTML = SVG.searchOfficial;
    var sInp = document.createElement("input");
    sInp.type = "search";
    sInp.className = "cc-sb-search searchInput_OOQiHg";
    sInp.placeholder = "Filter session files…";
    sInp.oninput = function () {
      filesFilterQuery = sInp.value.trim().toLowerCase();
      renderFilesTreeDom();
    };
    sBox.appendChild(sInp);
    fpSearchRowEl.appendChild(sBox);
    filesPopoverEl.appendChild(fpSearchRowEl);

    fpBodyEl = document.createElement("div");
    fpBodyEl.className = "cc-fp-body";
    fpBodyEl.addEventListener("scroll", closeContextMenu, { passive: true });
    filesPopoverEl.appendChild(fpBodyEl);

    document.body.appendChild(filesPopoverEl);

    document.addEventListener("pointerdown", function (ev) {
      if (!filesPopoverEl || !filesPopoverEl.classList.contains("open")) return;
      if (filesPopoverEl.contains(ev.target)) return;
      if (hdrFilesBtn && hdrFilesBtn.contains(ev.target)) return;
      if (ctxMenuEl && ctxMenuEl.contains(ev.target)) return;
      if (backdropEl && backdropEl.classList.contains("open")) return;
      closeFilesPopover();
    }, true);
  }

  function openFilesPopover() {
    ensureFilesPopoverDom();
    cachedSessionFiles = null;
    renderFilesTreeDom();
    var wasOpen = filesPopoverEl.classList.contains("open");
    filesPopoverEl.classList.add("open");
    if (hdrFilesBtn) hdrFilesBtn.classList.add("cc-panel-active");
    if (!wasOpen) {
      try { window.history.pushState({ ccFiles: true }, "", "#files"); } catch (_) {}
    }
    refreshFilesTree();
  }

  function closeFilesPopover(skipHistoryBack) {
    if (!filesPopoverEl || !filesPopoverEl.classList.contains("open")) return;
    filesPopoverEl.classList.remove("open");
    if (hdrFilesBtn) hdrFilesBtn.classList.remove("cc-panel-active");
    if (skipHistoryBack !== true && window.location.hash === "#files") {
      popOverlayHistory();
    }
  }

  function toggleFilesPopover() {
    if (filesPopoverEl && filesPopoverEl.classList.contains("open")) {
      closeFilesPopover();
    } else {
      openFilesPopover();
    }
  }

  // ---------------------------------------------------------------------------
  // Sidebar Construction (Clean Antigravity Layout)
  // ---------------------------------------------------------------------------
  function ensureSidebarDom() {
    if (sidebarEl) return;

    scrimEl = document.createElement("div");
    scrimEl.id = "cc-sb-scrim";
    scrimEl.onclick = function () { setSidebarOpen(false); };
    document.body.appendChild(scrimEl);

    sidebarEl = document.createElement("aside");
    sidebarEl.id = "cc-sidebar";
    sidebarEl.className = "root_djirOA";
    sidebarEl.setAttribute("aria-label", "Session manager");

    // 1. Clean Top Row: "Claude Code" + Search Toggle Icon
    var topRow = document.createElement("div");
    topRow.className = "cc-sb-top";

    var brand = document.createElement("span");
    brand.className = "cc-sb-brand";
    brand.textContent = "Claude Code";

    sbSearchToggleBtn = document.createElement("button");
    sbSearchToggleBtn.type = "button";
    sbSearchToggleBtn.className = "cc-row-btn";
    sbSearchToggleBtn.title = "Search sessions";
    sbSearchToggleBtn.setAttribute("aria-label", "Search sessions");
    sbSearchToggleBtn.innerHTML = SVG.search16;
    sbSearchToggleBtn.onclick = function () {
      searchBarOpen = !searchBarOpen;
      sbSearchWrap.classList.toggle("open", searchBarOpen);
      sbSearchToggleBtn.classList.toggle("active", searchBarOpen);
      if (searchBarOpen) {
        setTimeout(function () { sbSearchInput.focus(); }, 20);
      } else if (sidebarFilterQuery) {
        sbSearchInput.value = "";
        sidebarFilterQuery = "";
        renderWorkspacesTreeDom();
      }
    };

    topRow.appendChild(brand);
    topRow.appendChild(sbSearchToggleBtn);
    sidebarEl.appendChild(topRow);

    // 2. Primary "+ New session" Pill Button (Antigravity "+ New Conversation" style)
    var newWrap = document.createElement("div");
    newWrap.className = "cc-sb-new-wrap";
    var newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "cc-sb-new-pill";
    newBtn.innerHTML = SVG.plus15 + "<span>New session</span>";
    newBtn.onclick = startNewChatInCurrentWorkspace;
    newWrap.appendChild(newBtn);
    sidebarEl.appendChild(newWrap);

    // 3. Collapsible Filter Input (hidden unless magnifying glass is tapped)
    sbSearchWrap = document.createElement("div");
    sbSearchWrap.className = "cc-sb-search-wrap";
    var searchBox = document.createElement("div");
    searchBox.className = "searchBox_OOQiHg";
    searchBox.innerHTML = SVG.searchOfficial;
    sbSearchInput = document.createElement("input");
    sbSearchInput.type = "search";
    sbSearchInput.className = "cc-sb-search searchInput_OOQiHg";
    sbSearchInput.placeholder = "Filter projects or sessions…";
    sbSearchInput.oninput = function () {
      sidebarFilterQuery = sbSearchInput.value.trim().toLowerCase();
      renderWorkspacesTreeDom();
    };
    searchBox.appendChild(sbSearchInput);
    sbSearchWrap.appendChild(searchBox);
    sidebarEl.appendChild(sbSearchWrap);

    // 4. Scrollable Projects & Sessions Tree
    var scrollArea = document.createElement("div");
    scrollArea.className = "cc-sb-scroll";
    scrollArea.addEventListener("scroll", closeContextMenu, { passive: true });

    var secHdr = document.createElement("div");
    secHdr.className = "sectionHeader_djirOA";

    var secToggle = document.createElement("button");
    secToggle.type = "button";
    secToggle.className = "sectionToggle_djirOA";
    sbSecChevHolder = document.createElement("span");
    sbSecChevHolder.style.display = "inline-flex";
    sbSecChevHolder.innerHTML = SVG.chevOfficial("sectionChevron_djirOA sectionChevronExpanded_djirOA");
    var secLbl = document.createElement("span");
    secLbl.className = "sectionLabel_djirOA";
    secLbl.textContent = "Projects";
    secToggle.appendChild(sbSecChevHolder);
    secToggle.appendChild(secLbl);
    secToggle.onclick = function () {
      workspacesCollapsed = !workspacesCollapsed;
      sbSecChevHolder.innerHTML = SVG.chevOfficial(
        "sectionChevron_djirOA" + (workspacesCollapsed ? "" : " sectionChevronExpanded_djirOA")
      );
      sbBodyWrap.className = workspacesCollapsed
        ? "sessionsBody_djirOA sessionsBodyCollapsed_djirOA"
        : "sessionsBody_djirOA";
    };

    var addFolderBtn = document.createElement("button");
    addFolderBtn.type = "button";
    addFolderBtn.className = "cc-row-btn";
    addFolderBtn.title = "Open project folder";
    addFolderBtn.setAttribute("aria-label", "Open folder");
    addFolderBtn.innerHTML = SVG.newFolder15;
    addFolderBtn.onclick = function () {
      closeSidebarIfMobileOverlay(true);
      openFolderDialog();
    };

    secHdr.appendChild(secToggle);
    secHdr.appendChild(addFolderBtn);
    scrollArea.appendChild(secHdr);

    sbBodyWrap = document.createElement("div");
    sbBodyWrap.className = "sessionsBody_djirOA";
    var ooRoot = document.createElement("div");
    ooRoot.className = "root_OOQiHg sessionListOnly_OOQiHg";
    ooRoot.style.paddingTop = "2px";
    sbListEl = document.createElement("div");
    sbListEl.className = "sessionsList_OOQiHg";
    ooRoot.appendChild(sbListEl);
    sbBodyWrap.appendChild(ooRoot);
    scrollArea.appendChild(sbBodyWrap);

    sidebarEl.appendChild(scrollArea);

    // 5. Minimalist Single-Item Footer: ONLY "Settings" (Antigravity style)
    var footer = document.createElement("div");
    footer.className = "cc-sb-footer";

    var setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.className = "cc-sb-foot-item";
    setBtn.innerHTML = SVG.gear15 + "<span>Settings</span>";
    setBtn.onclick = function () {
      closeSidebarIfMobileOverlay(true);
      openSettingsDialog("general");
    };

    footer.appendChild(setBtn);
    sidebarEl.appendChild(footer);

    document.body.appendChild(sidebarEl);
  }

  function renderWorkspacesTreeDom() {
    if (!sbListEl || !cachedWorkspacesData) return;
    sbListEl.innerHTML = "";
    var q = sidebarFilterQuery;

    (cachedWorkspacesData.workspaces || []).forEach(function (ws) {
      var wsName = ws.name || basename(ws.path);
      var allSessions = ws.sessions || [];
      var filteredSessions = q
        ? allSessions.filter(function (s) {
            return String(s.title || "").toLowerCase().indexOf(q) !== -1 || wsName.toLowerCase().indexOf(q) !== -1;
          })
        : allSessions;

      if (q && filteredSessions.length === 0 && wsName.toLowerCase().indexOf(q) === -1) {
        return;
      }

      // Inactive empty folders start collapsed by default so they never create visual noise
      var defaultCollapsed = !ws.active && allSessions.length === 0;
      var isCollapsed = ws.path in collapsedWorkspaces ? collapsedWorkspaces[ws.path] : defaultCollapsed;
      var isExpanded = q ? true : !isCollapsed;

      var grpHdr = document.createElement("div");
      grpHdr.className = "groupHeader_OOQiHg" + (ws.active ? " cc-ws-active" : "");
      grpHdr.title = ws.path;

      var chevWrap = document.createElement("span");
      chevWrap.style.display = "inline-flex";
      chevWrap.innerHTML = SVG.chevOfficial(
        "groupChevron_OOQiHg" + (isExpanded ? " groupChevronExpanded_OOQiHg" : "")
      );

      var folderIco = document.createElement("span");
      folderIco.className = "cc-ws-folder-ico";
      folderIco.innerHTML = SVG.folder15;

      var grpName = document.createElement("span");
      grpName.className = "groupName_OOQiHg";
      grpName.textContent = wsName;

      grpHdr.appendChild(chevWrap);
      grpHdr.appendChild(folderIco);
      grpHdr.appendChild(grpName);

      var newInWs = document.createElement("button");
      newInWs.type = "button";
      newInWs.className = "cc-row-btn";
      newInWs.title = "New session in " + wsName;
      newInWs.innerHTML = SVG.plus14;
      newInWs.onclick = function (ev) {
        ev.stopPropagation();
        if (ws.active) startNewChatInCurrentWorkspace();
        else selectAndSwitchWorkspace(ws.path, null);
      };
      grpHdr.appendChild(newInWs);

      var wsMenuBtn = document.createElement("button");
      wsMenuBtn.type = "button";
      wsMenuBtn.className = "cc-row-btn";
      wsMenuBtn.title = "Project options";
      wsMenuBtn.innerHTML = SVG.dots14;
      wsMenuBtn.onclick = function (ev) {
        ev.stopPropagation();
        var items = [
          {
            label: "New session",
            icon: SVG.plus14,
            onClick: function () {
              if (ws.active) startNewChatInCurrentWorkspace();
              else selectAndSwitchWorkspace(ws.path, null);
            }
          },
          {
            label: "Open in Terminal",
            icon: SVG.terminal14,
            onClick: function () {
              if (ws.active) {
                closeSidebarIfMobileOverlay();
                showTerminalDock();
              } else {
                selectAndSwitchWorkspace(ws.path, null, function () {
                  showTerminalDock();
                });
              }
            }
          }
        ];
        if (!ws.active) {
          items.push({ separator: true });
          items.push({
            label: "Remove from list",
            icon: SVG.trash14,
            danger: true,
            onClick: function () {
              apiPost("/api/workspaces/remove", { workspace: ws.path }).then(function () {
                refreshSidebarTree();
                showToast("Removed " + wsName + " from list");
              });
            }
          });
        }
        showContextMenu(wsMenuBtn, items);
      };
      grpHdr.appendChild(wsMenuBtn);

      grpHdr.onclick = function () {
        if (!ws.active && allSessions.length === 0) {
          selectAndSwitchWorkspace(ws.path, null);
          return;
        }
        collapsedWorkspaces[ws.path] = isExpanded;
        renderWorkspacesTreeDom();
      };

      sbListEl.appendChild(grpHdr);

      if (isExpanded) {
        var subWrap = document.createElement("div");
        subWrap.className = "cc-ws-sessions";

        if (filteredSessions.length === 0) {
          var emptyNote = document.createElement("div");
          emptyNote.className = "cc-empty-note";
          emptyNote.textContent = "No conversations yet";
          subWrap.appendChild(emptyNote);
        } else {
          var liveSid = getLiveSessionId();
          filteredSessions.slice(0, 35).forEach(function (s) {
            var isActive = s.id === (liveSid || activeChatSessionId);
            var rowWrap = document.createElement("div");
            rowWrap.className = "sessionRowWrap" + (isActive ? " active" : "");

            var item = document.createElement("button");
            item.type = "button";
            item.className = "sessionItem_OOQiHg" + (isActive ? " active_OOQiHg" : "");
            item.title = s.title;
            item.innerHTML =
              '<span class="sessionName_OOQiHg">' + escapeHtml(s.title) + "</span>" +
              '<span class="sessionMeta_OOQiHg"><span class="sessionTime_OOQiHg">' +
              escapeHtml(formatRelativeTime(s.updatedAt)) +
              "</span></span>";
            item.onclick = function () {
              openChatSession(ws.path, s.id);
            };

            var moreBtn = document.createElement("button");
            moreBtn.type = "button";
            moreBtn.className = "cc-row-btn";
            moreBtn.title = "Session options";
            moreBtn.innerHTML = SVG.dots14;
            moreBtn.onclick = function (ev) {
              ev.stopPropagation();
              showContextMenu(moreBtn, [
                {
                  label: "Rename session…",
                  icon: SVG.edit14,
                  onClick: function () { promptRenameChatSession(s); }
                },
                {
                  label: "Delete session…",
                  icon: SVG.trash14,
                  danger: true,
                  onClick: function () { promptDeleteChatSession(s); }
                }
              ]);
            };

            rowWrap.appendChild(item);
            rowWrap.appendChild(moreBtn);
            subWrap.appendChild(rowWrap);
          });
        }
        sbListEl.appendChild(subWrap);
      }
    });
  }

  function refreshSidebarTree() {
    apiGet("/api/workspaces-tree").then(function (data) {
      if (!data || !Array.isArray(data.workspaces)) return;
      cachedWorkspacesData = data;
      if (data.activeWorkspace) setWorkspaceLabel(data.activeWorkspace);
      renderWorkspacesTreeDom();
    }).catch(function () {});
  }

  function scheduleSidebarRefresh(delayMs) {
    if (refreshTreeTimer) clearTimeout(refreshTreeTimer);
    refreshTreeTimer = setTimeout(function () {
      if (sidebarOpen && document.body.classList.contains("cc-authed")) {
        refreshSidebarTree();
      }
    }, delayMs || 800);
  }

  function hydrateSidebarIfAuthenticated() {
    if (!document.body.classList.contains("cc-authed")) return;
    ensureSidebarDom();
    document.body.classList.toggle("cc-sb-open", sidebarOpen);
    if (!sidebarDataHydrated && sidebarOpen) {
      sidebarDataHydrated = true;
      refreshSidebarTree();
    }
  }

  function syncAuthenticatedHeader() {
    var header = document.querySelector('[class*="header_aqhumA"]');
    if (!header) return;

    if (!document.body.classList.contains("cc-authed")) {
      document.body.classList.add("cc-authed");
    }
    hydrateSidebarIfAuthenticated();

    if (!hdrSidebarBtn) {
      hdrSidebarBtn = document.createElement("button");
      hdrSidebarBtn.type = "button";
      hdrSidebarBtn.setAttribute("data-cc-hdr-injected", "sidebar");
      hdrSidebarBtn.className = "iconButton_YKLzCw iconButton20_YKLzCw";
      hdrSidebarBtn.setAttribute("aria-label", "Toggle sidebar");
      hdrSidebarBtn.title = "Toggle sidebar";
      hdrSidebarBtn.innerHTML = SVG.sidebar20;
      hdrSidebarBtn.onclick = toggleSidebar;
    }

    if (!hdrFilesBtn) {
      hdrFilesBtn = document.createElement("button");
      hdrFilesBtn.type = "button";
      hdrFilesBtn.setAttribute("data-cc-hdr-injected", "files");
      hdrFilesBtn.className = "iconButton_YKLzCw iconButton20_YKLzCw";
      hdrFilesBtn.setAttribute("aria-label", "Session files");
      hdrFilesBtn.title = "Session files";
      hdrFilesBtn.innerHTML = SVG.files20;
      hdrFilesBtn.onclick = toggleFilesPopover;
    }

    if (!hdrTermBtn) {
      hdrTermBtn = document.createElement("button");
      hdrTermBtn.type = "button";
      hdrTermBtn.setAttribute("data-cc-hdr-injected", "term");
      hdrTermBtn.className = "iconButton_YKLzCw iconButton20_YKLzCw" + (ptyAlive ? " cc-term-running" : "");
      hdrTermBtn.setAttribute("aria-label", "Terminal");
      hdrTermBtn.title = "Toggle project terminal";
      hdrTermBtn.innerHTML = SVG.terminal20;
      hdrTermBtn.onclick = toggleTerminalDock;
    }

    if (header.firstElementChild !== hdrSidebarBtn) {
      header.insertBefore(hdrSidebarBtn, header.firstChild);
    }
    if (header.lastElementChild !== hdrTermBtn) {
      header.appendChild(hdrTermBtn);
    }
    if (hdrFilesBtn.nextSibling !== hdrTermBtn) {
      header.insertBefore(hdrFilesBtn, hdrTermBtn);
    }
  }

  // ---------------------------------------------------------------------------
  // C. Per-Project Persistent Bottom Docked Terminal (xterm.js + FitAddon + cc-pty)
  // ---------------------------------------------------------------------------
  var xtermLoadPromise = null;
  var dockEl = null;
  var dockDotEl = null;
  var dockMaxBtn = null;
  var xtermHostEl = null;
  var termInstance = null;
  var fitAddonInstance = null;
  var ptySocket = null;
  var connectedPtyId = "";
  var ptyAlive = false;
  var pendingPtyInputQueue = [];

  function currentWorkspacePtyId() {
    return "ws:" + normalizeWsPath(currentWorkspace);
  }

  function getXtermPalette(mode) {
    if (mode === "light") {
      return {
        background: "#faf9f5",
        foreground: "#141413",
        cursor: "#c96442",
        cursorAccent: "#faf9f5",
        selectionBackground: "rgba(201, 100, 66, 0.22)",
        black: "#141413",
        red: "#b8332a",
        green: "#2b7a3d",
        yellow: "#946200",
        blue: "#1f5fa8",
        magenta: "#7a3eb1",
        cyan: "#166f78",
        white: "#57544d",
        brightBlack: "#827e75",
        brightRed: "#d14338",
        brightGreen: "#37934c",
        brightYellow: "#b57900",
        brightBlue: "#2b74c7",
        brightMagenta: "#934fd1",
        brightCyan: "#1e8b96",
        brightWhite: "#141413"
      };
    }
    return {
      background: "#141413",
      foreground: "#f0eee6",
      cursor: "#d97757",
      cursorAccent: "#141413",
      selectionBackground: "rgba(217, 119, 87, 0.28)",
      black: "#1c1b18",
      red: "#ef6b6b",
      green: "#74c991",
      yellow: "#e5a94c",
      blue: "#6cb6ff",
      magenta: "#c297ff",
      cyan: "#56d4dd",
      white: "#f0eee6",
      brightBlack: "#878378",
      brightRed: "#f58989",
      brightGreen: "#8ed9a7",
      brightYellow: "#f0be6e",
      brightBlue: "#8cc6ff",
      brightMagenta: "#d3b3ff",
      brightCyan: "#79e1e8",
      brightWhite: "#ffffff"
    };
  }

  function syncXtermTheme() {
    if (termInstance) {
      termInstance.options.theme = getXtermPalette(currentTheme);
    }
  }

  function ensureXtermLoaded() {
    if (window.Terminal && window.FitAddon) return Promise.resolve();
    if (xtermLoadPromise) return xtermLoadPromise;
    xtermLoadPromise = new Promise(function (resolve, reject) {
      if (!document.getElementById("cc-xterm-css")) {
        var link = document.createElement("link");
        link.id = "cc-xterm-css";
        link.rel = "stylesheet";
        link.href = "/__cc_xterm.css";
        document.head.appendChild(link);
      }
      var sc = document.createElement("script");
      sc.src = "/__cc_xterm.js";
      sc.onload = function () { resolve(); };
      sc.onerror = function () {
        xtermLoadPromise = null;
        reject(new Error("Failed to load xterm.js"));
      };
      document.head.appendChild(sc);
    });
    return xtermLoadPromise;
  }

  function setPtyStatus(alive) {
    ptyAlive = !!alive;
    if (dockDotEl) dockDotEl.classList.toggle("live", ptyAlive);
    if (hdrTermBtn) hdrTermBtn.classList.toggle("cc-term-running", ptyAlive);
  }

  function sendPtyInput(str) {
    if (!str) return;
    if (ptySocket && ptySocket.readyState === 1) {
      ptySocket.send(JSON.stringify({ type: "input", data: str }));
    } else {
      if (pendingPtyInputQueue.length < 64) {
        pendingPtyInputQueue.push(str);
      }
    }
  }

  function fitAndNotifyPty() {
    if (!termInstance || !fitAddonInstance || !document.body.classList.contains("cc-term-dock-open")) return;
    try {
      fitAddonInstance.fit();
      if (ptySocket && ptySocket.readyState === 1) {
        ptySocket.send(JSON.stringify({
          type: "resize",
          rows: termInstance.rows,
          cols: termInstance.cols
        }));
      }
    } catch (_) {}
  }

  function connectPtyWebSocket() {
    var targetPtyId = currentWorkspacePtyId();
    if (ptySocket && connectedPtyId === targetPtyId && (ptySocket.readyState === 0 || ptySocket.readyState === 1)) {
      fitAndNotifyPty();
      return;
    }
    if (ptySocket) {
      var prev = ptySocket;
      ptySocket = null;
      try { prev.close(); } catch (_) {}
      if (termInstance) termInstance.reset();
    }

    connectedPtyId = targetPtyId;
    var cols = (termInstance && termInstance.cols) ? termInstance.cols : 92;
    var rows = (termInstance && termInstance.rows) ? termInstance.rows : 24;
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/pty?id=" + encodeURIComponent(targetPtyId) + "&cwd=" + encodeURIComponent(currentWorkspace) + "&cols=" + cols + "&rows=" + rows;
    var ws = new WebSocket(url);
    ptySocket = ws;

    ws.onopen = function () {
      if (ptySocket !== ws) return;
      setPtyStatus(true);
      fitAndNotifyPty();
      if (pendingPtyInputQueue.length > 0) {
        var queued = pendingPtyInputQueue.splice(0, pendingPtyInputQueue.length).join("");
        if (queued) ws.send(JSON.stringify({ type: "input", data: queued }));
      }
    };
    ws.onmessage = function (ev) {
      if (ptySocket !== ws) return;
      try {
        var msg = JSON.parse(ev.data);
        if (msg.type === "output" && msg.data && termInstance) {
          termInstance.write(msg.data);
        } else if (msg.type === "restarted" && termInstance) {
          termInstance.clear();
          setPtyStatus(true);
          fitAndNotifyPty();
        } else if (msg.type === "exit") {
          setPtyStatus(false);
          if (termInstance) termInstance.write("\r\n[process exited — press Enter to start a new shell]\r\n");
        }
      } catch (_) {}
    };
    ws.onclose = function () {
      if (ptySocket === ws) ptySocket = null;
    };
  }

  function rebindTerminalToWorkspace(nextWorkspace) {
    var normalized = normalizeWsPath(nextWorkspace);
    var changed = normalized !== currentWorkspace;
    setWorkspaceLabel(normalized);
    if (!changed) return;

    if (ptySocket) {
      var prev = ptySocket;
      ptySocket = null;
      connectedPtyId = "";
      try { prev.close(); } catch (_) {}
    }
    if (termInstance) termInstance.reset();
    if (document.body.classList.contains("cc-term-dock-open")) {
      connectPtyWebSocket();
    } else {
      apiGet("/api/info").then(function (info) {
        setPtyStatus(Boolean(info && info.workspacePtyAlive));
      }).catch(function () {});
    }
  }

  function ensureDockDom() {
    if (dockEl) return;
    dockEl = document.createElement("div");
    dockEl.id = "cc-term-dock";

    var bar = document.createElement("div");
    bar.className = "cc-dock-bar";

    var titleWrap = document.createElement("div");
    titleWrap.className = "cc-dock-title";
    dockDotEl = document.createElement("span");
    dockDotEl.className = "cc-dock-dot" + (ptyAlive ? " live" : "");
    dockFolderSpan = document.createElement("span");
    dockFolderSpan.textContent = "Terminal · " + basename(currentWorkspace);
    titleWrap.appendChild(dockDotEl);
    titleWrap.appendChild(dockFolderSpan);

    var actions = document.createElement("div");
    actions.className = "cc-dock-actions";

    var restartBtn = document.createElement("button");
    restartBtn.type = "button";
    restartBtn.className = "iconButton_YKLzCw iconButton16_YKLzCw";
    restartBtn.title = "Restart project shell";
    restartBtn.setAttribute("aria-label", "Restart shell");
    restartBtn.innerHTML = SVG.restart16;
    restartBtn.onclick = function () {
      if (termInstance) termInstance.reset();
      if (ptySocket && ptySocket.readyState === 1) {
        ptySocket.send(JSON.stringify({
          type: "restart",
          cwd: currentWorkspace,
          cols: termInstance ? termInstance.cols : 92,
          rows: termInstance ? termInstance.rows : 24
        }));
      } else {
        connectPtyWebSocket();
      }
    };

    dockMaxBtn = document.createElement("button");
    dockMaxBtn.type = "button";
    dockMaxBtn.className = "iconButton_YKLzCw iconButton16_YKLzCw";
    dockMaxBtn.title = "Toggle fullscreen";
    dockMaxBtn.setAttribute("aria-label", "Toggle fullscreen");
    dockMaxBtn.innerHTML = SVG.maximize16;
    dockMaxBtn.onclick = function () {
      var isFull = document.body.classList.toggle("cc-term-dock-full");
      dockMaxBtn.innerHTML = isFull ? SVG.restore16 : SVG.maximize16;
      setTimeout(fitAndNotifyPty, 40);
    };

    var hideBtn = document.createElement("button");
    hideBtn.type = "button";
    hideBtn.className = "iconButton_YKLzCw iconButton16_YKLzCw";
    hideBtn.title = "Hide panel (keep shell running)";
    hideBtn.setAttribute("aria-label", "Hide panel");
    hideBtn.innerHTML = SVG.minimize16;
    hideBtn.onclick = function () { hideTerminalDock(); };

    var killBtn = document.createElement("button");
    killBtn.type = "button";
    killBtn.className = "iconButton_YKLzCw iconButton16_YKLzCw";
    killBtn.title = "Terminate shell for this project";
    killBtn.setAttribute("aria-label", "Kill terminal");
    killBtn.innerHTML = SVG.close16;
    killBtn.onclick = function () {
      if (ptySocket && ptySocket.readyState === 1) {
        try { ptySocket.send(JSON.stringify({ type: "kill" })); } catch (_) {}
      }
      if (ptySocket) {
        try { ptySocket.close(); } catch (_) {}
        ptySocket = null;
      }
      connectedPtyId = "";
      if (termInstance) termInstance.reset();
      setPtyStatus(false);
      hideTerminalDock();
    };

    actions.appendChild(restartBtn);
    actions.appendChild(dockMaxBtn);
    actions.appendChild(hideBtn);
    actions.appendChild(killBtn);

    bar.appendChild(titleWrap);
    bar.appendChild(actions);

    xtermHostEl = document.createElement("div");
    xtermHostEl.id = "cc-xterm-host";

    var keyBar = document.createElement("div");
    keyBar.className = "cc-term-keybar";
    [
      { label: "Esc", seq: "\x1b" },
      { label: "Tab", seq: "\t" },
      { label: "Ctrl+C", seq: "\x03" },
      { label: "Ctrl+D", seq: "\x04" },
      { label: "Ctrl+L", seq: "\x0c" },
      { label: "↑", seq: "\x1b[A" },
      { label: "↓", seq: "\x1b[B" },
      { label: "←", seq: "\x1b[D" },
      { label: "→", seq: "\x1b[C" },
      { label: "Paste", paste: true }
    ].forEach(function (k) {
      var kb = document.createElement("button");
      kb.type = "button";
      kb.className = "cc-tkey";
      kb.textContent = k.label;
      kb.onmousedown = function (e) { e.preventDefault(); };
      kb.onclick = function () {
        if (k.paste) {
          if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText().then(function (txt) {
              if (txt) sendPtyInput(txt);
            }).catch(function () {});
          }
        } else {
          sendPtyInput(k.seq);
        }
        if (termInstance) termInstance.focus();
      };
      keyBar.appendChild(kb);
    });

    dockEl.appendChild(bar);
    dockEl.appendChild(xtermHostEl);
    dockEl.appendChild(keyBar);
    document.body.appendChild(dockEl);
  }

  function showTerminalDock(optionalCommand) {
    ensureDockDom();
    var wasOpen = document.body.classList.contains("cc-term-dock-open");
    document.body.classList.add("cc-term-dock-open");
    if (!wasOpen) {
      try { window.history.pushState({ ccTerm: true }, "", "#terminal"); } catch (_) {}
    }

    ensureXtermLoaded().then(function () {
      if (!termInstance) {
        var TermCtor = window.Terminal;
        var FitCtor = window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon);
        termInstance = new TermCtor({
          cursorBlink: true,
          fontSize: 12.5,
          lineHeight: 1.32,
          fontFamily: '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace',
          scrollback: 5000,
          convertEol: false,
          theme: getXtermPalette(currentTheme)
        });
        if (FitCtor) {
          fitAddonInstance = new FitCtor();
          termInstance.loadAddon(fitAddonInstance);
        }
        termInstance.open(xtermHostEl);
        termInstance.onData(function (data) {
          if (!ptySocket || ptySocket.readyState !== 1) {
            sendPtyInput(data);
            connectPtyWebSocket();
            return;
          }
          sendPtyInput(data);
        });

        if (window.ResizeObserver) {
          var ro = new ResizeObserver(function () { fitAndNotifyPty(); });
          ro.observe(xtermHostEl);
        }
        window.addEventListener("resize", fitAndNotifyPty);
      }

      if (optionalCommand && typeof optionalCommand === "string") {
        var cmdText = optionalCommand.endsWith("\n") ? optionalCommand : (optionalCommand + "\n");
        sendPtyInput(cmdText);
      }
      connectPtyWebSocket();
      setTimeout(function () {
        fitAndNotifyPty();
        if (termInstance) termInstance.focus();
      }, 50);
    }).catch(function (err) {
      showToast(err.message || "Could not initialize terminal");
    });
  }

  function hideTerminalDock(skipHistoryBack) {
    if (!document.body.classList.contains("cc-term-dock-open")) return;
    document.body.classList.remove("cc-term-dock-open", "cc-term-dock-full");
    if (dockMaxBtn) dockMaxBtn.innerHTML = SVG.maximize16;
    if (skipHistoryBack !== true && window.location.hash === "#terminal") {
      popOverlayHistory();
    }
  }

  function toggleTerminalDock() {
    if (document.body.classList.contains("cc-term-dock-open")) {
      hideTerminalDock();
    } else {
      showTerminalDock();
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Zero-Reload Hot Workspace Switcher & Open Folder Dialog
  // ---------------------------------------------------------------------------
  function selectAndSwitchWorkspace(targetPath, optionalSessionId, afterSwitchFn) {
    var normTarget = normalizeWsPath(targetPath);
    var payload = { workspace: normTarget };
    if (optionalSessionId) payload.sessionId = optionalSessionId;

    apiPost("/api/workspace", payload).then(function (res) {
      if (!res || !res.ok) {
        showToast((res && res.error) || "Could not open folder");
        return;
      }
      rebindTerminalToWorkspace(res.workspace);
      collapsedWorkspaces[normalizeWsPath(res.workspace)] = false;
      closeDialog();
      closeSidebarIfMobileOverlay();

      // Zero-reload in-place workspace switch (0ms, no WebView reload!)
      if (res.inPlace) {
        if (optionalSessionId) {
          activeChatSessionId = optionalSessionId;
          dispatchExtensionRequest({ type: "activate_session", sessionId: optionalSessionId });
        } else {
          activeChatSessionId = null;
          dispatchExtensionRequest({ type: "create_new_conversation" });
        }
        refreshSidebarTree();
        if (filesPopoverEl && filesPopoverEl.classList.contains("open")) {
          refreshFilesTree();
        }
        if (typeof afterSwitchFn === "function") afterSwitchFn();
        return;
      }

      var nextUrl = "/?panel=" + encodeURIComponent(res.activePanelId || "") + "&theme=" + encodeURIComponent(currentTheme);
      if (optionalSessionId) nextUrl += "&session=" + encodeURIComponent(optionalSessionId);
      window.location.href = nextUrl;
    });
  }

  function openFolderDialog() {
    openDialog("Open Project Folder", function (container) {
      var browsePath = currentWorkspace;

      var topRow = document.createElement("div");
      topRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;";

      var sysBtn = document.createElement("button");
      sysBtn.type = "button";
      sysBtn.className = "cc-btn primary";
      sysBtn.textContent = "Browse Device Storage";
      sysBtn.onclick = function () {
        var b = getBridge();
        if (b && typeof b.pickProjectDirectoryAuth === "function" && BRIDGE_TOKEN) {
          var cbId = nextCallbackId("dir_");
          pendingCallbacks[cbId] = function (picked) {
            if (picked) selectAndSwitchWorkspace(picked, null);
          };
          b.pickProjectDirectoryAuth(BRIDGE_TOKEN, cbId);
        }
      };
      topRow.appendChild(sysBtn);

      var newDirBtn = document.createElement("button");
      newDirBtn.type = "button";
      newDirBtn.className = "cc-btn";
      newDirBtn.textContent = "New Folder";
      newDirBtn.onclick = function () {
        openPromptModal({
          title: "New Folder",
          label: "Create folder inside " + browsePath,
          placeholder: "my-project",
          confirmLabel: "Create & Open",
          onConfirm: function (name) {
            apiPost("/api/fs/create", { parentDir: browsePath, name: name, kind: "directory" }).then(function (r) {
              if (r && r.ok && r.path) {
                selectAndSwitchWorkspace(r.path, null);
              } else {
                showToast((r && r.error) || "Could not create folder");
              }
            });
          }
        });
      };
      topRow.appendChild(newDirBtn);
      container.appendChild(topRow);

      var quickRow = document.createElement("div");
      quickRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;";
      [
        { label: "ClaudeCode", path: "/storage/emulated/0/Documents/ClaudeCode" },
        { label: "Documents", path: "/storage/emulated/0/Documents" },
        { label: "Download", path: "/storage/emulated/0/Download" },
        { label: "IA", path: "/storage/emulated/0/IA" }
      ].forEach(function (q) {
        var p = document.createElement("button");
        p.type = "button";
        p.className = "cc-pill";
        p.textContent = q.label;
        p.onclick = function () { loadDir(q.path); };
        quickRow.appendChild(p);
      });
      container.appendChild(quickRow);

      var pathBar = document.createElement("div");
      pathBar.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border:1px solid var(--app-primary-border-color);border-radius:4px;background:var(--app-secondary-background);margin-bottom:8px;";
      var pathLabel = document.createElement("div");
      pathLabel.style.cssText = "font-family:var(--app-monospace-font-family,monospace);font-size:11.5px;word-break:break-all;flex:1;";
      var selectHere = document.createElement("button");
      selectHere.type = "button";
      selectHere.className = "cc-btn primary";
      selectHere.textContent = "Open";
      selectHere.onclick = function () { selectAndSwitchWorkspace(browsePath, null); };
      pathBar.appendChild(pathLabel);
      pathBar.appendChild(selectHere);
      container.appendChild(pathBar);

      var listEl = document.createElement("div");
      container.appendChild(listEl);

      function loadDir(target) {
        browsePath = target;
        pathLabel.textContent = target;
        listEl.innerHTML = "";
        apiGet("/api/fs/list?path=" + encodeURIComponent(target)).then(function (data) {
          browsePath = data.directory || target;
          pathLabel.textContent = browsePath;
          listEl.innerHTML = "";
          if (browsePath !== "/" && data.parent && data.parent !== browsePath) {
            var up = document.createElement("div");
            up.className = "cc-row-item";
            up.innerHTML = '<span style="display:inline-flex;align-items:center;gap:8px;color:var(--app-secondary-foreground)">' + SVG.up16 + "<span>..</span></span>";
            up.onclick = function () { loadDir(data.parent); };
            listEl.appendChild(up);
          }
          var dirs = (data.items || []).filter(function (i) { return i.type === "directory"; });
          dirs.forEach(function (d) {
            var row = document.createElement("div");
            row.className = "cc-row-item";
            row.innerHTML = '<span style="display:inline-flex;align-items:center;gap:8px">' + SVG.folder15 + "<span>" + escapeHtml(d.name) + "</span></span>" + SVG.chevRight16;
            row.onclick = function () { loadDir(d.path); };
            listEl.appendChild(row);
          });
        });
      }

      loadDir(browsePath);
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Native File Editor Dialog (Used by Files Drawer, Skills & [/] Instructions)
  // ---------------------------------------------------------------------------
  function openFileEditorDialog(filePath, initialContent, dialogTitle, onSavedCallback, onCloseExtra) {
    openDialog(dialogTitle || basename(filePath), function (container, hdrRight) {
      var pathHint = document.createElement("div");
      pathHint.style.cssText = "font-family:var(--app-monospace-font-family,monospace);font-size:11px;color:var(--app-secondary-foreground);margin-bottom:8px;word-break:break-all;";
      pathHint.textContent = filePath;
      container.appendChild(pathHint);

      var ta = document.createElement("textarea");
      ta.className = "cc-editor-area";
      ta.spellcheck = false;
      ta.value = initialContent != null ? initialContent : "";
      container.appendChild(ta);

      var saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "cc-btn primary";
      saveBtn.style.padding = "4px 10px";
      saveBtn.textContent = "Save";
      saveBtn.onclick = function () {
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving...";
        apiPost("/api/fs/write", { filePath: filePath, content: ta.value }).then(function (res) {
          saveBtn.disabled = false;
          saveBtn.textContent = "Save";
          if (res && res.ok) {
            showToast("Saved " + basename(filePath));
            if (typeof onSavedCallback === "function") onSavedCallback();
          } else {
            showToast((res && res.error) || "Could not save file");
          }
        }).catch(function () {
          saveBtn.disabled = false;
          saveBtn.textContent = "Save";
          showToast("Save failed");
        });
      };
      hdrRight.appendChild(saveBtn);

      if (initialContent == null) {
        ta.placeholder = "Loading...";
        apiPost("/api/fs/read", { filePath: filePath }).then(function (r) {
          ta.placeholder = "";
          ta.value = (r && r.content) || "";
        });
      }
    }, onCloseExtra);
  }

  // ---------------------------------------------------------------------------
  // 3. Unified Settings Dialog (General · Plugins · Skills · API & Model · System)
  // ---------------------------------------------------------------------------
  function openSettingsDialog(initialTab) {
    var activeTab = initialTab || "general";
    openDialog("Settings", function (container) {
      var tabBar = document.createElement("div");
      tabBar.className = "cc-tabs";
      var content = document.createElement("div");
      container.appendChild(tabBar);
      container.appendChild(content);

      var tabs = [
        { id: "general", label: "General" },
        { id: "plugins", label: "Plugins" },
        { id: "skills", label: "Skills" },
        { id: "api", label: "API & Model" },
        { id: "system", label: "System" }
      ];

      function renderTabs() {
        tabBar.innerHTML = "";
        tabs.forEach(function (t) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "cc-tab" + (activeTab === t.id ? " active" : "");
          b.textContent = t.label;
          b.onclick = function () {
            activeTab = t.id;
            renderTabs();
            renderActivePane();
          };
          tabBar.appendChild(b);
        });
      }

      function renderActivePane() {
        activeUpdateRenderer = null;
        content.innerHTML = "";
        if (activeTab === "general") renderGeneralPane(content);
        else if (activeTab === "plugins") renderPluginsPane(content);
        else if (activeTab === "skills") renderSkillsPane(content);
        else if (activeTab === "api") renderApiPane(content);
        else renderSystemPane(content);
      }

      renderTabs();
      renderActivePane();
    });
  }

  // Official claudeCode.* options (the ones VS Code shows in its Settings screen) that apply
  // on a phone. Values are stored by the host and read by the official extension.
  function settingLabel(key) {
    var name = String(key).replace(/^claudeCode\./, "");
    return name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, function (c) { return c.toUpperCase(); });
  }

  function settingEnumLabel(key, v) {
    if (key === "claudeCode.archiveInactiveSessions") {
      return v === 0 ? "Never" : (v === 1 ? "1 day" : v + " days");
    }
    return String(v);
  }

  function renderGeneralPane(el) {
    el.innerHTML = "";
    apiGet("/api/settings/general").then(function (data) {
      if (!el.isConnected) return;
      el.innerHTML = "";
      (data.settings || []).forEach(function (s) {
        var row = document.createElement("div");
        row.className = "cc-card";
        row.style.cssText = "display:flex;align-items:flex-start;justify-content:space-between;gap:12px;";

        var text = document.createElement("div");
        text.style.cssText = "flex:1;min-width:0;";
        var title = document.createElement("div");
        title.style.cssText = "font-size:13px;font-weight:500;margin-bottom:3px;";
        title.textContent = settingLabel(s.key);
        var desc = document.createElement("div");
        desc.style.cssText = "font-size:12px;line-height:1.4;color:var(--app-secondary-foreground);word-break:break-word;";
        desc.textContent = s.description;
        text.appendChild(title);
        text.appendChild(desc);
        row.appendChild(text);

        var save = function (value, control) {
          control.disabled = true;
          apiPost("/api/settings/general", { key: s.key, value: value }).then(function (r) {
            control.disabled = false;
            if (!r || !r.ok) showToast((r && r.error) || "Could not save setting");
          }).catch(function () {
            control.disabled = false;
            showToast("Could not save setting");
          });
        };

        if (s.type === "boolean") {
          var chk = document.createElement("input");
          chk.type = "checkbox";
          chk.checked = s.value === true;
          chk.style.cssText = "width:18px;height:18px;margin-top:2px;flex-shrink:0;accent-color:var(--app-claude-orange,#d97757);";
          chk.onchange = function () { save(chk.checked, chk); };
          row.appendChild(chk);
        } else if (s.enum) {
          var sel = document.createElement("select");
          sel.className = "cc-input";
          sel.style.cssText = "width:auto;max-width:150px;flex-shrink:0;";
          if (s.value === undefined || s.value === null) {
            var unset = document.createElement("option");
            unset.value = "";
            unset.textContent = "(CLI default)";
            sel.appendChild(unset);
          }
          s.enum.forEach(function (v, idx) {
            var opt = document.createElement("option");
            opt.value = String(idx);
            opt.textContent = settingEnumLabel(s.key, v);
            if (v === s.value) opt.selected = true;
            sel.appendChild(opt);
          });
          sel.onchange = function () {
            if (sel.value === "") return;
            save(s.enum[Number(sel.value)], sel);
          };
          row.appendChild(sel);
        }
        el.appendChild(row);
      });
    }).catch(function () {
      if (el.isConnected) el.textContent = "Could not load settings.";
    });
  }

  function renderPluginsPane(el) {
    var b = getBridge();
    var catalogPromise = Promise.resolve({ plugins: [] });
    if (b && typeof b.getPluginsCatalogJson === "function") {
      try { catalogPromise = Promise.resolve(JSON.parse(b.getPluginsCatalogJson())); } catch (_) {}
    } else {
      catalogPromise = apiGet("/__cc_plugins_catalog.json").catch(function () { return { plugins: [] }; });
    }

    var installedMap = {};
    if (b && typeof b.listAndroidPluginsAuth === "function" && BRIDGE_TOKEN) {
      try { installedMap = JSON.parse(b.listAndroidPluginsAuth(BRIDGE_TOKEN)) || {}; } catch (_) {}
    }

    catalogPromise.then(function (cat) {
      if (!el.isConnected) return;
      el.innerHTML = "";
      (cat.plugins || []).forEach(function (pl) {
        var st = installedMap[pl.name];
        var isInst = !!(st && st.installed);
        var isEn = !!(st && st.enabled !== false);

        var card = document.createElement("div");
        card.className = "cc-card";
        card.innerHTML =
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px">' +
          '<span style="font-weight:500">' + escapeHtml(pl.title || pl.name) + "</span>" +
          '<span style="font-size:11px;color:var(--app-secondary-foreground)">' + escapeHtml(pl.version || "") + "</span>" +
          "</div>" +
          '<div style="font-size:12px;color:var(--app-secondary-foreground);line-height:1.4;margin-bottom:8px">' + escapeHtml(pl.description || "") + "</div>";

        var actions = document.createElement("div");
        actions.style.cssText = "display:flex;gap:6px;";

        if (!isInst) {
          var instBtn = document.createElement("button");
          instBtn.type = "button";
          instBtn.className = "cc-btn primary";
          instBtn.textContent = "Install";
          instBtn.onclick = function () {
            if (!b || !BRIDGE_TOKEN) return;
            instBtn.disabled = true;
            instBtn.textContent = "Installing...";
            var cbId = nextCallbackId("pl_");
            pendingCallbacks[cbId] = function (r) {
              showToast(r && r.ok ? (pl.title + " installed") : ((r && r.error) || "Install failed"));
              renderPluginsPane(el);
            };
            b.installMarketplacePluginAsync(BRIDGE_TOKEN, cbId, pl.name, pl.archiveUrl || "", pl.name, "android-arm64", pl.version || "1.0.0");
          };
          actions.appendChild(instBtn);
        } else {
          var togBtn = document.createElement("button");
          togBtn.type = "button";
          togBtn.className = "cc-btn";
          togBtn.textContent = isEn ? "Disable" : "Enable";
          togBtn.onclick = function () {
            if (!b || !BRIDGE_TOKEN) return;
            togBtn.disabled = true;
            var cbId = nextCallbackId("tg_");
            pendingCallbacks[cbId] = function () { renderPluginsPane(el); };
            b.toggleAndroidPluginAsync(BRIDGE_TOKEN, cbId, pl.name, !isEn);
          };
          actions.appendChild(togBtn);

          var rmBtn = document.createElement("button");
          rmBtn.type = "button";
          rmBtn.className = "cc-btn";
          rmBtn.textContent = "Remove";
          rmBtn.onclick = function () {
            if (!b || !BRIDGE_TOKEN) return;
            rmBtn.disabled = true;
            var cbId = nextCallbackId("rm_");
            pendingCallbacks[cbId] = function () { renderPluginsPane(el); };
            b.uninstallMarketplacePluginAsync(BRIDGE_TOKEN, cbId, pl.name);
          };
          actions.appendChild(rmBtn);
        }

        card.appendChild(actions);
        el.appendChild(card);
      });
    });
  }

  function renderSkillsPane(el) {
    apiGet("/api/skills").then(function (data) {
      if (!el.isConnected) return;
      el.innerHTML = "";

      var bar = document.createElement("div");
      bar.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;";

      var fileInp = document.createElement("input");
      fileInp.type = "file";
      fileInp.accept = ".zip,.skill,application/zip";
      fileInp.style.display = "none";

      var upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "cc-btn primary";
      upBtn.textContent = "Upload .zip / .skill";
      upBtn.onclick = function () { fileInp.click(); };

      fileInp.onchange = function () {
        var f = fileInp.files && fileInp.files[0];
        if (!f) return;
        upBtn.disabled = true;
        upBtn.textContent = "Importing...";
        var reader = new FileReader();
        reader.onload = function () {
          var resStr = String(reader.result || "");
          var comma = resStr.indexOf(",");
          var b64 = comma >= 0 ? resStr.slice(comma + 1) : resStr;
          apiPost("/api/skills/import-zip", { fileName: f.name, base64: b64 }).then(function (r) {
            if (r && r.ok) {
              showToast("Imported skill: " + r.skillName);
              renderSkillsPane(el);
            } else {
              upBtn.disabled = false;
              upBtn.textContent = "Upload .zip / .skill";
              showToast((r && r.error) || "Import failed");
            }
          });
        };
        reader.readAsDataURL(f);
      };

      var newSkillBtn = document.createElement("button");
      newSkillBtn.type = "button";
      newSkillBtn.className = "cc-btn";
      newSkillBtn.textContent = "+ New Skill";
      newSkillBtn.onclick = function () {
        openPromptModal({
          title: "New Skill",
          label: "Skill identifier (slash command)",
          placeholder: "code-reviewer",
          confirmLabel: "Create",
          onConfirm: function (name) {
            var clean = name.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
            if (!clean) return;
            var tpl = [
              "---",
              "name: " + clean,
              "description: Describe when Claude should activate this skill.",
              "---",
              "",
              "# " + clean,
              "",
              "Write step-by-step instructions here..."
            ].join("\n");
            apiPost("/api/skills/save", { name: clean, content: tpl }).then(function (r) {
              if (r && r.ok && r.skillMdPath) {
                openFileEditorDialog(r.skillMdPath, tpl, "Skill: " + clean, function () {
                  openSettingsDialog("skills");
                });
              }
            });
          }
        });
      };

      bar.appendChild(fileInp);
      bar.appendChild(upBtn);
      bar.appendChild(newSkillBtn);
      el.appendChild(bar);

      var desc = document.createElement("div");
      desc.style.cssText = "font-size:12px;color:var(--app-secondary-foreground);margin-bottom:8px;";
      desc.textContent = "Installed skills in ~/.claude/skills:";
      el.appendChild(desc);

      (data.skills || []).forEach(function (s) {
        var row = document.createElement("div");
        row.className = "cc-card";
        row.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;";

        var left = document.createElement("span");
        left.style.cssText = "font-family:var(--app-monospace-font-family,monospace);font-size:12px;";
        left.textContent = "/" + s.name;

        var right = document.createElement("div");
        right.style.cssText = "display:inline-flex;gap:6px;align-items:center;";

        if (s.skillMdPath) {
          var editBtn = document.createElement("button");
          editBtn.type = "button";
          editBtn.className = "cc-pill";
          editBtn.textContent = "Edit";
          editBtn.onclick = function () {
            openFileEditorDialog(s.skillMdPath, null, "Skill: " + s.name);
          };
          right.appendChild(editBtn);
        }

        var delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "cc-pill";
        delBtn.textContent = "Remove";
        delBtn.onclick = function () {
          openConfirmModal({
            title: "Remove Skill",
            message: 'Remove skill "/' + s.name + '"?',
            confirmLabel: "Remove",
            danger: true,
            onConfirm: function () {
              apiPost("/api/skills/delete", { name: s.name }).then(function (r) {
                if (r && r.ok) {
                  showToast("Removed /" + s.name);
                  openSettingsDialog("skills");
                }
              });
            }
          });
        };
        right.appendChild(delBtn);

        row.appendChild(left);
        row.appendChild(right);
        el.appendChild(row);
      });
    });
  }

  function renderApiPane(el) {
    apiGet("/api/auth/config").then(function (cfg) {
      if (!el.isConnected) return;
      el.innerHTML = "";

      var statusCard = document.createElement("div");
      statusCard.className = "cc-card";
      var modeLabel = cfg.activeMode === "oauth"
        ? "Claude.ai Subscription (OAuth)"
        : (cfg.activeMode === "apikey" ? ("API Key" + (cfg.baseUrl ? " · Custom Endpoint" : "")) : "Not signed in");
      statusCard.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<span style="color:var(--app-secondary-foreground);font-size:12px">Active Authentication</span>' +
        '<span style="font-weight:500;font-size:12px">' + escapeHtml(modeLabel) + "</span>" +
        "</div>";
      el.appendChild(statusCard);

      var presetsRow = document.createElement("div");
      presetsRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;";
      [
        { label: "Anthropic", url: "", model: "" },
        { label: "OpenRouter", url: "https://openrouter.ai/api", model: "anthropic/claude-sonnet-4" },
        { label: "DeepSeek", url: "https://api.deepseek.com/anthropic", model: "deepseek-chat" },
        { label: "Z.ai GLM", url: "https://api.z.ai/api/anthropic", model: "glm-4.7" }
      ].forEach(function (pr) {
        var p = document.createElement("button");
        p.type = "button";
        p.className = "cc-pill";
        p.textContent = pr.label;
        p.onclick = function () {
          urlInp.value = pr.url;
          modelInp.value = pr.model;
        };
        presetsRow.appendChild(p);
      });
      el.appendChild(presetsRow);

      var l1 = document.createElement("label");
      l1.className = "cc-label";
      l1.textContent = "API Key" + (cfg.hasApiKey ? " (saved: " + cfg.maskedApiKey + ")" : "");
      var keyInp = document.createElement("input");
      keyInp.type = "password";
      keyInp.className = "cc-input";
      keyInp.placeholder = cfg.hasApiKey ? "Leave blank to keep saved key" : "sk-ant-api03-...";
      keyInp.style.marginBottom = "10px";

      var l2 = document.createElement("label");
      l2.className = "cc-label";
      l2.textContent = "Base URL (optional)";
      var urlInp = document.createElement("input");
      urlInp.type = "text";
      urlInp.className = "cc-input";
      urlInp.value = cfg.baseUrl || "";
      urlInp.placeholder = "https://api.anthropic.com";
      urlInp.style.marginBottom = "10px";

      var l3 = document.createElement("label");
      l3.className = "cc-label";
      l3.textContent = "Default Model Override (optional)";
      var modelInp = document.createElement("input");
      modelInp.type = "text";
      modelInp.className = "cc-input";
      modelInp.value = cfg.model || "";
      modelInp.placeholder = "claude-sonnet-4-5";
      modelInp.style.marginBottom = "12px";

      var btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";

      var saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "cc-btn primary";
      saveBtn.textContent = cfg.activeMode === "oauth" ? "Switch to API Key" : "Apply API Key";
      saveBtn.onclick = function () {
        var typedKey = keyInp.value.trim();
        if (!typedKey && !cfg.hasApiKey) {
          keyInp.focus();
          return;
        }
        saveBtn.disabled = true;
        saveBtn.textContent = "Applying...";
        if (typedKey && !persistApiKeySecurely(typedKey)) {
          saveBtn.disabled = false;
          saveBtn.textContent = cfg.activeMode === "oauth" ? "Switch to API Key" : "Apply API Key";
          showToast("Could not store the API key securely on this device");
          return;
        }
        var payload = {
          authMode: "apikey",
          baseUrl: urlInp.value.trim(),
          model: modelInp.value.trim()
        };
        if (typedKey) payload.apiKey = typedKey;
        apiPost("/api/auth/config", payload).then(function (res) {
          closeDialog();
          navigateAfterAuthChange(res);
        });
      };
      btnRow.appendChild(saveBtn);

      if (cfg.hasApiKey || cfg.hasOAuthBackup) {
        var clrBtn = document.createElement("button");
        clrBtn.type = "button";
        clrBtn.className = "cc-btn";
        clrBtn.textContent = cfg.hasOAuthBackup ? "Restore Claude.ai Subscription" : "Clear API Key";
        clrBtn.onclick = function () {
          clrBtn.disabled = true;
          clearStoredApiKey();
          apiPost("/api/auth/config", { clearApiKey: true, authMode: "oauth" }).then(function (res) {
            closeDialog();
            navigateAfterAuthChange(res);
          });
        };
        btnRow.appendChild(clrBtn);
      }

      el.appendChild(l1);
      el.appendChild(keyInp);
      el.appendChild(l2);
      el.appendChild(urlInp);
      el.appendChild(l3);
      el.appendChild(modelInp);
      el.appendChild(btnRow);
    });
  }

  function renderSystemPane(el) {
    var b = getBridge();
    var curTheme = (b && typeof b.getTheme === "function") ? b.getTheme() : INITIAL_THEME;
    var appVer = (b && typeof b.getAppVersion === "function") ? b.getAppVersion() : "2.1.331-r1";

    var themeCard = document.createElement("div");
    themeCard.className = "cc-card";
    themeCard.innerHTML = '<div class="cc-label" style="margin-bottom:8px">Appearance</div>';
    var tRow = document.createElement("div");
    tRow.style.cssText = "display:flex;gap:6px;";
    [
      { id: "dark", label: "Dark" },
      { id: "light", label: "Light" },
      { id: "system", label: "System" }
    ].forEach(function (t) {
      var tb = document.createElement("button");
      tb.type = "button";
      tb.className = "cc-pill" + (curTheme === t.id ? " active" : "");
      tb.textContent = t.label;
      tb.onclick = function () {
        if (b && typeof b.setThemeByUser === "function") b.setThemeByUser(t.id);
        applyResolvedTheme(t.id === "light" ? "light" : "dark");
        renderSystemPane(el);
      };
      tRow.appendChild(tb);
    });
    themeCard.appendChild(tRow);
    el.appendChild(themeCard);

    var sysCard = document.createElement("div");
    sysCard.className = "cc-card";
    sysCard.innerHTML =
      '<div style="display:flex;justify-content:space-between;margin-bottom:10px"><span>Claude Code Engine</span><span style="color:var(--app-secondary-foreground)">v' + escapeHtml(appVer) + " (ARM64)</span></div>";

    var actRow = document.createElement("div");
    actRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
    var updBtn = document.createElement("button");
    updBtn.type = "button";
    updBtn.className = "cc-btn";
    updBtn.textContent = "Check for Updates";
    updBtn.onclick = function () {
      if (b && b.checkForAppUpdates) {
        showToast("Checking GitHub releases...");
        b.checkForAppUpdates(true);
      }
    };
    actRow.appendChild(updBtn);
    sysCard.appendChild(actRow);

    var updBanner = document.createElement("div");
    updBanner.style.marginTop = "8px";
    sysCard.appendChild(updBanner);
    activeUpdateRenderer = function () {
      updBanner.innerHTML = "";
      if (latestUpdateState && latestUpdateState.type === "ready") {
        var ap = document.createElement("button");
        ap.type = "button";
        ap.className = "cc-btn primary";
        ap.textContent = "Install Update " + (latestUpdateState.version || "");
        ap.onclick = function () { if (b && BRIDGE_TOKEN) b.applyAppUpdateAuth(BRIDGE_TOKEN); };
        updBanner.appendChild(ap);
      }
    };
    activeUpdateRenderer();
    el.appendChild(sysCard);

    var acctCard = document.createElement("div");
    acctCard.className = "cc-card";
    el.appendChild(acctCard);
    apiGet("/api/auth/config").then(function (cfg) {
      if (!acctCard.isConnected) return;
      var modeLabel = (cfg && cfg.activeMode === "oauth")
        ? "Claude.ai Subscription"
        : ((cfg && cfg.activeMode === "apikey") ? ("API Key" + (cfg.maskedApiKey ? " (" + cfg.maskedApiKey + ")" : "")) : "Signed out");

      var head = document.createElement("div");
      head.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;";
      var title = document.createElement("span");
      title.textContent = "Account";
      var status = document.createElement("span");
      status.style.cssText = "color:var(--app-secondary-foreground);font-size:12px;";
      status.textContent = modeLabel;
      head.appendChild(title);
      head.appendChild(status);
      acctCard.appendChild(head);

      var signOutBtn = document.createElement("button");
      signOutBtn.type = "button";
      signOutBtn.className = "cc-btn danger";
      signOutBtn.textContent = "Sign out";
      signOutBtn.disabled = !cfg || cfg.activeMode === "none";
      signOutBtn.onclick = function () {
        openConfirmModal({
          title: "Sign out",
          message: "Sign out of Claude Code on this device? Your projects and chat history will stay saved.",
          confirmLabel: "Sign out",
          danger: true,
          onConfirm: function () {
            clearStoredApiKey();
            apiPost("/api/auth/logout", {}).then(function (res) {
              navigateAfterAuthChange(res);
            }).catch(function () {
              showToast("Could not sign out");
            });
          }
        });
      };
      acctCard.appendChild(signOutBtn);
    }).catch(function () {});
  }

  // ---------------------------------------------------------------------------
  // 4. File Editor & Diff Preview Dialog (Supports saving CLAUDE.md / text files!)
  // ---------------------------------------------------------------------------
  function showPreviewDialog(pkt) {
    var closeId = pkt.tabId || pkt.previewId;
    var cleanup = function () {
      if (closeId) apiPost("/api/preview/close", { tabId: closeId }).catch(function () {});
    };

    if (pkt.kind !== "diff" && pkt.filePath && String(pkt.filePath).indexOf("/") === 0) {
      openFileEditorDialog(
        pkt.filePath,
        pkt.content != null ? pkt.content : "",
        pkt.title || basename(pkt.filePath),
        function () {
          if (filesPopoverEl && filesPopoverEl.classList.contains("open")) refreshFilesTree();
        },
        cleanup
      );
      return;
    }

    openDialog(pkt.title || basename(pkt.filePath || "Preview"), function (container) {
      if (pkt.kind === "diff") {
        var pre = document.createElement("pre");
        pre.style.cssText = "margin:0;padding:10px;border-radius:4px;background:var(--app-code-background,#111110);font-family:var(--app-monospace-font-family,monospace);font-size:11.5px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;";
        var leftRaw = pkt.leftText != null ? pkt.leftText : (pkt.leftContent || "");
        var rightRaw = pkt.rightText != null ? pkt.rightText : (pkt.rightContent || "");
        var leftLines = String(leftRaw).split("\n");
        var rightLines = String(rightRaw).split("\n");
        var html = [];
        var max = Math.max(leftLines.length, rightLines.length);
        for (var i = 0; i < max; i++) {
          var l = leftLines[i];
          var r = rightLines[i];
          if (l === r) {
            if (r !== undefined) html.push("  " + escapeHtml(r));
          } else {
            if (l !== undefined) html.push('<span style="color:var(--app-diff-deletion-foreground,#ef6b6b)">- ' + escapeHtml(l) + "</span>");
            if (r !== undefined) html.push('<span style="color:var(--app-diff-addition-foreground,#6bc46d)">+ ' + escapeHtml(r) + "</span>");
          }
        }
        pre.innerHTML = html.join("\n");
        container.appendChild(pre);
      } else {
        var code = document.createElement("pre");
        code.style.cssText = "margin:0;padding:10px;border-radius:4px;background:var(--app-code-background,#111110);font-family:var(--app-monospace-font-family,monospace);font-size:12px;overflow-x:auto;white-space:pre-wrap;";
        code.textContent = pkt.content || "";
        container.appendChild(code);
      }
    }, cleanup);
  }

  // ---------------------------------------------------------------------------
  // 5. Real user answers for extension prompts (showWarningMessage / QuickPick / InputBox)
  //    The host never answers on the user's behalf; dismissing = undefined (VS Code semantics).
  // ---------------------------------------------------------------------------
  var promptQueue = [];
  var knownPromptIds = Object.create(null);
  var activePrompt = null; // { id, answered }
  var actionToastEl = null;
  var actionToastPrompt = null; // { id, answered, timer }

  function replyUserPrompt(state, payload) {
    if (!state || state.answered) return;
    state.answered = true;
    apiPost("/api/prompt/reply", Object.assign({ promptId: state.id }, payload || {})).catch(function () {});
  }

  function enqueueUserPrompt(pkt) {
    if (!pkt.promptId || knownPromptIds[pkt.promptId]) return;
    knownPromptIds[pkt.promptId] = true;
    if (pkt.kind === "message" && !pkt.modal) {
      showActionToast(pkt);
      return;
    }
    promptQueue.push(pkt);
    showNextUserPrompt();
  }

  function dropUserPrompt(promptId) {
    delete knownPromptIds[promptId];
    promptQueue = promptQueue.filter(function (p) { return p.promptId !== promptId; });
    if (activePrompt && activePrompt.id === promptId) {
      activePrompt.answered = true;
      closeDialog();
    }
    if (actionToastPrompt && actionToastPrompt.id === promptId) {
      actionToastPrompt.answered = true;
      hideActionToast();
    }
  }

  function promptButton(label, cls, onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cc-btn" + (cls ? " " + cls : "");
    btn.textContent = label;
    btn.onclick = onClick;
    return btn;
  }

  function showNextUserPrompt() {
    if (activePrompt || promptQueue.length === 0) return;
    var pkt = promptQueue.shift();
    var state = { id: pkt.promptId, answered: false };
    activePrompt = state;

    var title;
    if (pkt.kind === "quickpick") title = pkt.title || pkt.placeHolder || "Choose an option";
    else if (pkt.kind === "input") title = pkt.title || "Input";
    else title = pkt.level === "error" ? "Error" : (pkt.level === "warn" ? "Warning" : "Claude Code");

    openDialog(title, function (container) {
      var actions = document.createElement("div");
      actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:14px;";

      if (pkt.kind === "message") {
        var msg = document.createElement("div");
        msg.style.cssText = "font-size:13px;line-height:1.45;white-space:pre-wrap;word-break:break-word;";
        msg.textContent = pkt.message || "";
        container.appendChild(msg);
        if (pkt.detail) {
          var det = document.createElement("div");
          det.style.cssText = "font-size:12px;line-height:1.45;color:var(--app-secondary-foreground);white-space:pre-wrap;word-break:break-word;margin-top:8px;";
          det.textContent = pkt.detail;
          container.appendChild(det);
        }
        actions.appendChild(promptButton("Cancel", "", function () { closeDialog(); }));
        (pkt.items || []).forEach(function (label, idx) {
          actions.appendChild(promptButton(label, "", function () {
            replyUserPrompt(state, { index: idx });
            closeDialog();
          }));
        });
        container.appendChild(actions);
      } else if (pkt.kind === "quickpick") {
        if (pkt.placeHolder && pkt.title) {
          var ph = document.createElement("div");
          ph.className = "cc-label";
          ph.textContent = pkt.placeHolder;
          container.appendChild(ph);
        }
        (pkt.items || []).forEach(function (label, idx) {
          var row = document.createElement("div");
          row.className = "cc-row-item";
          var left = document.createElement("span");
          left.textContent = label;
          row.appendChild(left);
          var desc = pkt.descriptions && pkt.descriptions[idx];
          if (desc) {
            var right = document.createElement("span");
            right.style.cssText = "font-size:11.5px;color:var(--app-secondary-foreground);text-align:right;";
            right.textContent = desc;
            row.appendChild(right);
          }
          row.onclick = function () {
            replyUserPrompt(state, { index: idx });
            closeDialog();
          };
          container.appendChild(row);
        });
        actions.appendChild(promptButton("Cancel", "", function () { closeDialog(); }));
        container.appendChild(actions);
      } else {
        if (pkt.prompt) {
          var lbl = document.createElement("label");
          lbl.className = "cc-label";
          lbl.textContent = pkt.prompt;
          container.appendChild(lbl);
        }
        var inp = document.createElement("input");
        inp.type = pkt.password ? "password" : "text";
        inp.className = "cc-input";
        inp.value = pkt.value || "";
        inp.placeholder = pkt.placeHolder || "";
        container.appendChild(inp);
        if (pkt.validationMessage) {
          var vm = document.createElement("div");
          vm.style.cssText = "font-size:12px;color:var(--app-diff-deletion-foreground,#ef6b6b);margin-top:6px;";
          vm.textContent = pkt.validationMessage;
          container.appendChild(vm);
        }
        var submit = function () {
          replyUserPrompt(state, { value: inp.value });
          closeDialog();
        };
        inp.onkeydown = function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        };
        actions.appendChild(promptButton("Cancel", "", function () { closeDialog(); }));
        actions.appendChild(promptButton("OK", "primary", submit));
        container.appendChild(actions);
        setTimeout(function () { inp.focus(); inp.select(); }, 30);
      }
    }, function () {
      replyUserPrompt(state, {});
      delete knownPromptIds[state.id];
      if (activePrompt === state) activePrompt = null;
      setTimeout(showNextUserPrompt, 0);
    }, 440);
  }

  function hideActionToast() {
    if (actionToastPrompt && actionToastPrompt.timer) clearTimeout(actionToastPrompt.timer);
    if (actionToastPrompt) {
      replyUserPrompt(actionToastPrompt, {});
      delete knownPromptIds[actionToastPrompt.id];
    }
    actionToastPrompt = null;
    if (actionToastEl) actionToastEl.style.display = "none";
  }

  function showActionToast(pkt) {
    if (actionToastPrompt) hideActionToast();
    if (!actionToastEl) {
      actionToastEl = document.createElement("div");
      actionToastEl.id = "cc-action-toast";
      actionToastEl.style.cssText = "position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:9450;width:min(420px,calc(100vw - 24px));box-sizing:border-box;padding:10px 12px;border-radius:6px;background:var(--app-menu-background,var(--app-secondary-background));color:var(--app-menu-foreground,var(--app-primary-foreground));border:1px solid var(--app-menu-border,var(--app-primary-border-color));box-shadow:0 8px 24px rgba(0,0,0,0.45);font-family:var(--vscode-chat-font-family);font-size:12.5px;display:none;";
      document.body.appendChild(actionToastEl);
    }
    var state = { id: pkt.promptId, answered: false, timer: null };
    actionToastPrompt = state;
    actionToastEl.innerHTML = "";
    var msg = document.createElement("div");
    msg.style.cssText = "line-height:1.4;word-break:break-word;margin-bottom:8px;";
    msg.textContent = pkt.message || "";
    actionToastEl.appendChild(msg);
    var row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap;";
    (pkt.items || []).forEach(function (label, idx) {
      row.appendChild(promptButton(label, "", function () {
        replyUserPrompt(state, { index: idx });
        hideActionToast();
      }));
    });
    row.appendChild(promptButton("Dismiss", "", function () { hideActionToast(); }));
    actionToastEl.appendChild(row);
    actionToastEl.style.display = "block";
    state.timer = setTimeout(function () {
      if (actionToastPrompt === state) hideActionToast();
    }, 20000);
  }

  var domSyncScheduled = false;
  function syncDomIntegrations() {
    syncLoginScreenOption();
    syncAuthenticatedHeader();
  }

  function scheduleDomIntegrations() {
    if (domSyncScheduled) return;
    domSyncScheduled = true;
    window.requestAnimationFrame(function () {
      domSyncScheduled = false;
      syncDomIntegrations();
    });
  }

  function boot() {
    injectNativeStyles();
    applyResolvedTheme(INITIAL_THEME);
    hydrateSidebarIfAuthenticated();

    var urlSession = null;
    try { urlSession = new URLSearchParams(window.location.search).get("session"); } catch (_) {}
    if (urlSession) activeChatSessionId = urlSession;

    apiGet("/api/info").then(function (info) {
      if (info && info.workspace) setWorkspaceLabel(info.workspace);
      if (info && typeof info.workspacePtyAlive === "boolean") {
        setPtyStatus(info.workspacePtyAlive);
      }
    }).catch(function () {});

    syncDomIntegrations();
    var obs = new MutationObserver(scheduleDomIntegrations);
    obs.observe(document.documentElement, { childList: true, subtree: true });

    setInterval(function () {
      if (sidebarOpen && document.body.classList.contains("cc-authed") && !document.hidden) {
        refreshSidebarTree();
      }
    }, 10000);

    var b = getBridge();
    if (b && typeof b.onUiReady === "function") {
      setTimeout(function () {
        try { b.onUiReady(); } catch (_) {}
      }, 200);
    }
  }

  window.addEventListener("cc:host-event", function (ev) {
    var pkt = (ev && ev.detail) || {};
    var kind = pkt.__cc_host_event;
    if (kind === "open_external" && pkt.url) {
      var b = getBridge();
      if (b && typeof b.openUrl === "function") b.openUrl(pkt.url);
      else window.open(pkt.url, "_blank");
    } else if (kind === "toast" && pkt.text) {
      showToast(pkt.text);
    } else if (kind === "user_prompt") {
      enqueueUserPrompt(pkt);
    } else if (kind === "open_settings") {
      openSettingsDialog("general");
    } else if (kind === "user_prompt_closed" && pkt.promptId) {
      dropUserPrompt(pkt.promptId);
    } else if (kind === "open_preview") {
      if (pkt.kind === "terminal") {
        showTerminalDock(pkt.command || "");
      } else {
        showPreviewDialog(pkt);
      }
    } else if (kind === "workspace_changed" && pkt.workspace) {
      rebindTerminalToWorkspace(pkt.workspace);
      scheduleSidebarRefresh(200);
      if (filesPopoverEl && filesPopoverEl.classList.contains("open")) {
        refreshFilesTree();
      }
    } else if (kind === "session_renamed" && pkt.sessionId) {
      dispatchExtensionRequest({ type: "session_renamed", sessionId: pkt.sessionId, title: pkt.title });
      scheduleSidebarRefresh(150);
    } else if (kind === "session_deleted") {
      scheduleSidebarRefresh(150);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
