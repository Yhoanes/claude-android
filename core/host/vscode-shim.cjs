"use strict";

/**
 * vscode-shim.cjs — Native Standalone Host Shim for Anthropic Claude Code v2.1.331
 *
 * Implements the exact `vscode` module surface consumed by `extension.js` so the
 * official Claude Code Full-Editor Agentic UI (`IS_FULL_EDITOR = true`) runs
 * standalone on Android ARM64 with zero VS Code desktop chrome.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

function createVSCodeShim(hostOpts) {
  const port = hostOpts.port || 45177;
  const extensionPath = hostOpts.extensionPath;
  const storageDir = hostOpts.storageDir;
  const onPanelCreated = hostOpts.onPanelCreated || (() => {});
  const onPanelDisposed = hostOpts.onPanelDisposed || (() => {});
  const onPanelMessage = hostOpts.onPanelMessage || (() => {});
  const onOpenExternal = hostOpts.onOpenExternal || (() => {});
  const onShowMessage = hostOpts.onShowMessage || (() => {});
  const onOpenPreview = hostOpts.onOpenPreview || (() => {});
  const onOpenSettings = hostOpts.onOpenSettings || (() => {});
  // Asks the real user through the WebView. Must resolve to the chosen index (number),
  // the typed string (input), or undefined when dismissed / no UI is connected.
  const onUserPrompt = hostOpts.onUserPrompt || (() => Promise.resolve(undefined));
  const log = hostOpts.log || console.log;

  fs.mkdirSync(storageDir, { recursive: true });

  // ---------------------------------------------------------------------------
  // Core Primitives: Disposable, EventEmitter, CancellationTokenSource
  // ---------------------------------------------------------------------------
  class Disposable {
    constructor(callOnDispose) {
      this._callOnDispose = typeof callOnDispose === "function" ? callOnDispose : null;
      this._disposed = false;
    }
    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      if (this._callOnDispose) {
        try {
          this._callOnDispose();
        } catch (_) {}
      }
    }
    static from(...items) {
      return new Disposable(() => {
        for (const it of items) {
          if (it && typeof it.dispose === "function") {
            try { it.dispose(); } catch (_) {}
          }
        }
      });
    }
  }

  class EventEmitter {
    constructor() {
      this._listeners = new Set();
      this.event = (listener, thisArgs, disposables) => {
        const wrapped = thisArgs ? listener.bind(thisArgs) : listener;
        this._listeners.add(wrapped);
        const disp = new Disposable(() => {
          this._listeners.delete(wrapped);
        });
        if (Array.isArray(disposables)) {
          disposables.push(disp);
        }
        return disp;
      };
    }
    fire(data) {
      for (const fn of Array.from(this._listeners)) {
        try {
          fn(data);
        } catch (err) {
          log("[vscode-shim] listener error:", err && err.stack ? err.stack : err);
        }
      }
    }
    dispose() {
      this._listeners.clear();
    }
  }

  class CancellationTokenSource {
    constructor() {
      this._emitter = new EventEmitter();
      this._cancelled = false;
      this.token = {
        get isCancellationRequested() {
          return this._cancelled;
        },
        onCancellationRequested: this._emitter.event,
      };
      Object.defineProperty(this.token, "isCancellationRequested", {
        get: () => this._cancelled,
      });
    }
    cancel() {
      if (!this._cancelled) {
        this._cancelled = true;
        this._emitter.fire(undefined);
      }
    }
    dispose() {
      this._emitter.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // Uri
  // ---------------------------------------------------------------------------
  class Uri {
    constructor(scheme, authority, uriPath, query, fragment) {
      this.scheme = scheme || "file";
      this.authority = authority || "";
      this.path = uriPath || "";
      this.query = query || "";
      this.fragment = fragment || "";
    }
    get fsPath() {
      return this.path || "";
    }
    with(change) {
      if (!change) return this;
      return new Uri(
        change.scheme !== undefined ? change.scheme : this.scheme,
        change.authority !== undefined ? change.authority : this.authority,
        change.path !== undefined ? change.path : this.path,
        change.query !== undefined ? change.query : this.query,
        change.fragment !== undefined ? change.fragment : this.fragment
      );
    }
    toString(skipEncoding) {
      let out = "";
      if (this.scheme) out += this.scheme + ":";
      if (this.authority || this.scheme === "file" || this.scheme === "http" || this.scheme === "https" || this.scheme === "ws") {
        out += "//" + (this.authority || "");
      }
      let p = this.path || "";
      if (!skipEncoding && this.scheme !== "http" && this.scheme !== "https") {
        // Preserve slashes while safely encoding special chars if needed
        p = p.split("/").map((seg) => encodeURIComponent(decodeURIComponentSafe(seg))).join("/");
      }
      out += p;
      if (this.query) out += "?" + this.query;
      if (this.fragment) out += "#" + this.fragment;
      return out;
    }
    toJSON() {
      return {
        $mid: 1,
        fsPath: this.fsPath,
        external: this.toString(),
        path: this.path,
        scheme: this.scheme,
        authority: this.authority,
        query: this.query,
        fragment: this.fragment,
      };
    }
    static file(p) {
      const resolved = p ? String(p).replace(/\\/g, "/") : "/";
      const normalized = resolved.startsWith("/") ? resolved : "/" + resolved;
      return new Uri("file", "", normalized, "", "");
    }
    static joinPath(base, ...segments) {
      const joined = path.posix.join(base.path || "/", ...segments.map((s) => String(s).replace(/\\/g, "/")));
      return base.with({ path: joined });
    }
    static from(components) {
      return new Uri(
        components.scheme,
        components.authority || "",
        components.path || "",
        components.query || "",
        components.fragment || ""
      );
    }
    static parse(value) {
      if (!value) return new Uri("file", "", "/", "", "");
      const str = String(value);
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(str);
      if (!m) {
        return Uri.file(str);
      }
      return new Uri(
        m[1].toLowerCase(),
        decodeURIComponentSafe(m[2] || ""),
        decodeURIComponentSafe(m[3] || ""),
        m[4] || "",
        decodeURIComponentSafe(m[5] || "")
      );
    }
  }

  function decodeURIComponentSafe(s) {
    try {
      return decodeURIComponent(s);
    } catch (_) {
      return s;
    }
  }

  // ---------------------------------------------------------------------------
  // Geometry & Edits: Position, Range, Selection, Location, WorkspaceEdit
  // ---------------------------------------------------------------------------
  class Position {
    constructor(line, character) {
      this.line = Math.max(0, Number(line) || 0);
      this.character = Math.max(0, Number(character) || 0);
    }
    isEqual(other) {
      return !!other && this.line === other.line && this.character === other.character;
    }
    isBefore(other) {
      return this.line < other.line || (this.line === other.line && this.character < other.character);
    }
    isAfter(other) {
      return other.isBefore(this);
    }
    compareTo(other) {
      if (this.isEqual(other)) return 0;
      return this.isBefore(other) ? -1 : 1;
    }
    translate(lineDelta = 0, charDelta = 0) {
      if (typeof lineDelta === "object" && lineDelta !== null) {
        return new Position(this.line + (lineDelta.lineDelta || 0), this.character + (lineDelta.characterDelta || 0));
      }
      return new Position(this.line + lineDelta, this.character + charDelta);
    }
    with(line, character) {
      if (typeof line === "object" && line !== null) {
        return new Position(
          line.line !== undefined ? line.line : this.line,
          line.character !== undefined ? line.character : this.character
        );
      }
      return new Position(line !== undefined ? line : this.line, character !== undefined ? character : this.character);
    }
  }

  class Range {
    constructor(a, b, c, d) {
      if (a instanceof Position || (a && typeof a.line === "number")) {
        const p1 = new Position(a.line, a.character);
        const p2 = b ? new Position(b.line, b.character) : p1;
        this.start = p1.isBefore(p2) || p1.isEqual(p2) ? p1 : p2;
        this.end = p1.isBefore(p2) || p1.isEqual(p2) ? p2 : p1;
      } else {
        this.start = new Position(a, b);
        this.end = new Position(c, d);
      }
    }
    get isEmpty() {
      return this.start.isEqual(this.end);
    }
    get isSingleLine() {
      return this.start.line === this.end.line;
    }
    contains(posOrRange) {
      if (!posOrRange) return false;
      if (posOrRange.start && posOrRange.end) {
        return this.contains(posOrRange.start) && this.contains(posOrRange.end);
      }
      return !posOrRange.isBefore(this.start) && !posOrRange.isAfter(this.end);
    }
    isEqual(other) {
      return !!other && this.start.isEqual(other.start) && this.end.isEqual(other.end);
    }
    intersection(other) {
      if (!other) return undefined;
      const start = this.start.isAfter(other.start) ? this.start : other.start;
      const end = this.end.isBefore(other.end) ? this.end : other.end;
      if (start.isAfter(end)) return undefined;
      return new Range(start, end);
    }
    union(other) {
      if (!other) return this;
      const start = this.start.isBefore(other.start) ? this.start : other.start;
      const end = this.end.isAfter(other.end) ? this.end : other.end;
      return new Range(start, end);
    }
    with(start, end) {
      return new Range(start || this.start, end || this.end);
    }
  }

  class Selection extends Range {
    constructor(a, b, c, d) {
      if (a instanceof Position || (a && typeof a.line === "number")) {
        const anchor = new Position(a.line, a.character);
        const active = b ? new Position(b.line, b.character) : anchor;
        super(anchor, active);
        this.anchor = anchor;
        this.active = active;
      } else {
        const anchor = new Position(a, b);
        const active = new Position(c, d);
        super(anchor, active);
        this.anchor = anchor;
        this.active = active;
      }
    }
    get isReversed() {
      return this.active.isBefore(this.anchor);
    }
  }

  class Location {
    constructor(uri, rangeOrPosition) {
      this.uri = uri;
      this.range = rangeOrPosition instanceof Range
        ? rangeOrPosition
        : new Range(rangeOrPosition || new Position(0, 0), rangeOrPosition || new Position(0, 0));
    }
  }

  class RelativePattern {
    constructor(base, pattern) {
      if (typeof base === "string") {
        this.baseUri = Uri.file(base);
        this.base = base;
      } else if (base && base.uri) {
        this.baseUri = base.uri;
        this.base = base.uri.fsPath;
      } else if (base instanceof Uri) {
        this.baseUri = base;
        this.base = base.fsPath;
      } else {
        this.baseUri = Uri.file(currentWorkspaceDir || "/");
        this.base = this.baseUri.fsPath;
      }
      this.pattern = String(pattern || "*");
    }
  }

  class TextEdit {
    constructor(range, newText) {
      this.range = range;
      this.newText = newText || "";
    }
    static replace(range, newText) { return new TextEdit(range, newText); }
    static insert(pos, newText) { return new TextEdit(new Range(pos, pos), newText); }
    static delete(range) { return new TextEdit(range, ""); }
  }

  class WorkspaceEdit {
    constructor() {
      this._ops = [];
      this._map = new Map();
    }
    replace(uri, range, newText) {
      this._addTextEdit(uri, new TextEdit(range, newText));
    }
    insert(uri, pos, newText) {
      this._addTextEdit(uri, new TextEdit(new Range(pos, pos), newText));
    }
    delete(uri, range) {
      this._addTextEdit(uri, new TextEdit(range, ""));
    }
    _addTextEdit(uri, edit) {
      const key = uri.toString();
      if (!this._map.has(key)) this._map.set(key, { uri, edits: [] });
      this._map.get(key).edits.push(edit);
      this._ops.push({ kind: "edit", uri, edit });
    }
    set(uri, edits) {
      const key = uri.toString();
      this._map.set(key, { uri, edits: Array.isArray(edits) ? edits.slice() : [] });
      this._ops.push({ kind: "set", uri, edits: Array.isArray(edits) ? edits.slice() : [] });
    }
    get(uri) {
      const item = this._map.get(uri.toString());
      return item ? item.edits : [];
    }
    has(uri) {
      return this._map.has(uri.toString());
    }
    entries() {
      return Array.from(this._map.values()).map((v) => [v.uri, v.edits]);
    }
    createFile(uri, options) {
      this._ops.push({ kind: "create", uri, options: options || {} });
    }
    deleteFile(uri, options) {
      this._ops.push({ kind: "delete", uri, options: options || {} });
    }
    renameFile(oldUri, newUri, options) {
      this._ops.push({ kind: "rename", oldUri, newUri, options: options || {} });
    }
    get size() {
      return this._map.size + this._ops.filter((o) => o.kind !== "edit").length;
    }
  }

  // ---------------------------------------------------------------------------
  // Errors, UI Tokens & Tab Inputs
  // ---------------------------------------------------------------------------
  class FileSystemError extends Error {
    constructor(message, code) {
      super(message || code || "FileSystemError");
      this.code = code || "Unknown";
    }
    static FileNotFound(u) { return new FileSystemError(String(u || ""), "FileNotFound"); }
    static FileExists(u) { return new FileSystemError(String(u || ""), "FileExists"); }
    static FileNotADirectory(u) { return new FileSystemError(String(u || ""), "FileNotADirectory"); }
    static FileIsADirectory(u) { return new FileSystemError(String(u || ""), "FileIsADirectory"); }
    static NoPermissions(u) { return new FileSystemError(String(u || ""), "NoPermissions"); }
    static Unavailable(u) { return new FileSystemError(String(u || ""), "Unavailable"); }
  }

  class ThemeIcon {
    constructor(id, color) { this.id = id; this.color = color; }
  }
  class ThemeColor {
    constructor(id) { this.id = id; }
  }
  class MarkdownString {
    constructor(value = "", supportThemeIcons = false) {
      this.value = value;
      this.supportThemeIcons = supportThemeIcons;
      this.isTrusted = false;
    }
    appendText(v) { this.value += String(v || ""); return this; }
    appendMarkdown(v) { this.value += String(v || ""); return this; }
    appendCodeblock(v, lang = "") { this.value += `\n\`\`\`${lang}\n${v}\n\`\`\`\n`; return this; }
  }

  class TabInputText { constructor(uri) { this.uri = uri; } }
  class TabInputTextDiff { constructor(original, modified) { this.original = original; this.modified = modified; } }
  class TabInputCustom { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } }
  class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
  class TabInputNotebook { constructor(uri, notebookType) { this.uri = uri; this.notebookType = notebookType; } }
  class TabInputNotebookDiff { constructor(original, modified, notebookType) { this.original = original; this.modified = modified; this.notebookType = notebookType; } }
  class TabInputTerminal { constructor() {} }

  // ---------------------------------------------------------------------------
  // Enums
  // ---------------------------------------------------------------------------
  const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4 };
  const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
  const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
  const UIKind = { Desktop: 1, Web: 2 };
  const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
  const FileChangeType = { Changed: 1, Created: 2, Deleted: 3 };
  const EndOfLine = { LF: 1, CRLF: 2 };
  const StatusBarAlignment = { Left: 1, Right: 2 };
  const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
  const TextDocumentChangeReason = { Undo: 1, Redo: 2 };
  const TextDocumentSaveReason = { Manual: 1, AfterDelay: 2, FocusOut: 3 };
  const TextEditorSelectionChangeKind = { Keyboard: 1, Mouse: 2, Command: 3 };
  const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };
  const CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 };
  const CommentThreadState = { Unresolved: 0, Resolved: 1 };
  const NotebookCellKind = { Markup: 1, Code: 2 };
  const NotebookEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };
  const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
  const CodeActionTriggerKind = { Invoke: 1, Automatic: 2 };

  class CodeActionKind {
    constructor(value = "") {
      this.value = String(value);
    }
    append(parts) {
      const p = String(parts || "");
      return new CodeActionKind(this.value ? `${this.value}.${p}` : p);
    }
    contains(other) {
      const ov = other ? String(other.value ?? other) : "";
      return this.value === "" || ov === this.value || ov.startsWith(this.value + ".");
    }
    intersects(other) {
      return this.contains(other) || (other instanceof CodeActionKind && other.contains(this));
    }
  }
  CodeActionKind.Empty = new CodeActionKind("");
  CodeActionKind.QuickFix = new CodeActionKind("quickfix");
  CodeActionKind.Refactor = new CodeActionKind("refactor");
  CodeActionKind.RefactorExtract = new CodeActionKind("refactor.extract");
  CodeActionKind.RefactorInline = new CodeActionKind("refactor.inline");
  CodeActionKind.RefactorMove = new CodeActionKind("refactor.move");
  CodeActionKind.RefactorRewrite = new CodeActionKind("refactor.rewrite");
  CodeActionKind.Source = new CodeActionKind("source");
  CodeActionKind.SourceOrganizeImports = new CodeActionKind("source.organizeImports");
  CodeActionKind.SourceFixAll = new CodeActionKind("source.fixAll");

  class CodeAction {
    constructor(title, kind) {
      this.title = String(title || "");
      this.kind = kind;
      this.diagnostics = undefined;
      this.isPreferred = false;
      this.edit = undefined;
      this.command = undefined;
    }
  }

  class NotebookRange {
    constructor(start, end) {
      this.start = Math.max(0, Number(start) || 0);
      this.end = Math.max(this.start, Number(end) || 0);
    }
    get isEmpty() {
      return this.start === this.end;
    }
    with(change = {}) {
      return new NotebookRange(
        change.start !== undefined ? change.start : this.start,
        change.end !== undefined ? change.end : this.end
      );
    }
  }

  class NotebookCellData {
    constructor(kind, value, languageId) {
      this.kind = kind;
      this.value = String(value || "");
      this.languageId = String(languageId || "plaintext");
      this.outputs = [];
      this.metadata = undefined;
      this.executionSummary = undefined;
    }
  }

  const NotebookCellOutputItem = {
    error: (err) => ({ mime: "application/vnd.code.notebook.error", data: Buffer.from(JSON.stringify({ name: err?.name || "Error", message: err?.message || String(err), stack: err?.stack || "" })) }),
    text: (val, mime = "text/plain") => ({ mime, data: Buffer.from(String(val)) }),
    stdout: (val) => ({ mime: "application/vnd.code.notebook.stdout", data: Buffer.from(String(val)) }),
    stderr: (val) => ({ mime: "application/vnd.code.notebook.stderr", data: Buffer.from(String(val)) }),
    json: (val, mime = "application/json") => ({ mime, data: Buffer.from(JSON.stringify(val)) }),
  };

  const NotebookEdit = {
    insertCells: (index, cells) => ({ index, cells, type: "insert" }),
    replaceCells: (range, cells) => ({ range, cells, type: "replace" }),
    deleteCells: (range) => ({ range, type: "delete" }),
  };

  // ---------------------------------------------------------------------------
  // Persistent JSON State (Memento, SecretStorage, Configuration)
  // ---------------------------------------------------------------------------
  function createJsonMemento(filePath, defaults = {}) {
    let data = { ...defaults };
    try {
      if (fs.existsSync(filePath)) {
        data = { ...defaults, ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
      }
    } catch (_) {}
    const save = () => {
      try {
        const tmp = filePath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, filePath);
      } catch (_) {}
    };
    return {
      keys: () => Object.keys(data),
      get: (key, defaultValue) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : defaultValue),
      update: async (key, value) => {
        if (value === undefined) delete data[key];
        else data[key] = value;
        save();
      },
      setKeysForSync: () => {},
    };
  }

  function createSecretStorage(filePath) {
    const onDidChangeEmitter = new EventEmitter();
    let secrets = {};
    try {
      if (fs.existsSync(filePath)) {
        secrets = JSON.parse(fs.readFileSync(filePath, "utf8"));
      }
    } catch (_) {}
    const save = () => {
      try {
        const tmp = filePath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(secrets, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, filePath);
      } catch (_) {}
    };
    return {
      onDidChange: onDidChangeEmitter.event,
      get: async (key) => (Object.prototype.hasOwnProperty.call(secrets, key) ? secrets[key] : undefined),
      store: async (key, value) => {
        secrets[key] = String(value);
        save();
        onDidChangeEmitter.fire({ key });
      },
      delete: async (key) => {
        delete secrets[key];
        save();
        onDidChangeEmitter.fire({ key });
      },
      keys: async () => Object.keys(secrets),
    };
  }

  const configStorePath = path.join(storageDir, "host-config.json");
  let configData = {
    "claudeCode.preferredLocation": "panel",
    "claudeCode.useTerminal": false,
    "claudeCode.respectGitIgnore": true,
    "claudeCode.environmentVariables": [],
    "editor.fontSize": 13,
    "editor.fontFamily": "JetBrains Mono, monospace",
    "editor.fontWeight": "normal",
    "chat.fontSize": 14,
    "chat.editor.fontSize": 13,
    "files.autoSave": "afterDelay",
    "workbench.colorTheme": "Claude Warm Dark",
  };
  try {
    if (fs.existsSync(configStorePath)) {
      configData = { ...configData, ...JSON.parse(fs.readFileSync(configStorePath, "utf8")) };
    }
  } catch (_) {}
  // Never set claudeCode.claudeProcessWrapper here: extension.js treats processWrapper
  // as a prefix (e.g. wsl) and prepends the binary path to argv[1]. Instead,
  // resources/native-binary/claude points directly to our native Android launcher!
  delete configData["claudeCode.claudeProcessWrapper"];

  const configChangeEmitter = new EventEmitter();
  // Defaults the extension contributes in package.json (what VS Code returns when unset).
  const contributedDefaults = {};
  const contributedSchema = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(extensionPath, "package.json"), "utf8"));
    for (const block of [].concat((pkg.contributes && pkg.contributes.configuration) || [])) {
      for (const [k, v] of Object.entries((block && block.properties) || {})) {
        contributedSchema[k] = v;
        if (v && Object.prototype.hasOwnProperty.call(v, "default")) contributedDefaults[k] = v.default;
      }
    }
  } catch (_) {}
  // API keys must never be persisted in plaintext; they reach claude via process.env.
  const SECRET_ENV_NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

  function persistableConfig() {
    const copy = { ...configData };
    const vars = copy["claudeCode.environmentVariables"];
    if (Array.isArray(vars)) {
      copy["claudeCode.environmentVariables"] = vars.filter((v) => !(v && SECRET_ENV_NAMES.includes(v.name)));
    }
    return copy;
  }

  function saveConfigData() {
    try {
      const tmp = configStorePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(persistableConfig(), null, 2), { mode: 0o600 });
      fs.renameSync(tmp, configStorePath);
    } catch (_) {}
  }

  // Scrub plaintext secrets left on disk by older versions.
  configData = persistableConfig();
  saveConfigData();

  function updateHostSetting(fullKey, value) {
    if (value === undefined) delete configData[fullKey];
    else configData[fullKey] = value;
    saveConfigData();
    configChangeEmitter.fire({
      affectsConfiguration: (section) => fullKey === section || fullKey.startsWith(section + ".") || section.startsWith(fullKey + "."),
    });
  }

  // ---------------------------------------------------------------------------
  // Workspace & Virtual FileSystem Providers
  // ---------------------------------------------------------------------------
  let currentWorkspaceDir = hostOpts.initialWorkspace || process.cwd();
  const workspaceFoldersEmitter = new EventEmitter();
  const fsProviders = new Map();
  const contentProviders = new Map();
  const openDocuments = new Map();
  const docOpenEmitter = new EventEmitter();
  const docChangeEmitter = new EventEmitter();
  const docCloseEmitter = new EventEmitter();
  const docSaveEmitter = new EventEmitter();
  const docWillSaveEmitter = new EventEmitter();

  function makeWorkspaceFolders() {
    if (!currentWorkspaceDir) return [];
    return [{
      uri: Uri.file(currentWorkspaceDir),
      name: path.basename(currentWorkspaceDir) || "Workspace",
      index: 0,
    }];
  }

  function setWorkspaceDirectory(newDir) {
    const resolved = path.resolve(newDir);
    fs.mkdirSync(resolved, { recursive: true });
    const oldFolders = makeWorkspaceFolders();
    currentWorkspaceDir = resolved;
    const newFolders = makeWorkspaceFolders();
    workspaceFoldersEmitter.fire({ added: newFolders, removed: oldFolders });
    return resolved;
  }

  function createTextDocument(uri, text) {
    let content = String(text ?? "");
    const lines = () => content.split(/\r?\n/);
    const offsetAt = (pos) => {
      const ls = lines();
      const l = Math.min(Math.max(0, pos.line), Math.max(0, ls.length - 1));
      let off = 0;
      for (let i = 0; i < l; i++) off += ls[i].length + 1;
      return off + Math.min(Math.max(0, pos.character), (ls[l] || "").length);
    };
    const positionAt = (offset) => {
      const clamped = Math.max(0, Math.min(content.length, offset));
      const slice = content.slice(0, clamped).split("\n");
      return new Position(slice.length - 1, slice[slice.length - 1].length);
    };
    const doc = {
      uri,
      fileName: uri.fsPath,
      isUntitled: false,
      languageId: guessLanguageId(uri.path),
      version: 1,
      isDirty: false,
      isClosed: false,
      eol: EndOfLine.LF,
      get lineCount() { return lines().length; },
      lineAt(lineOrPos) {
        const idx = typeof lineOrPos === "number" ? lineOrPos : lineOrPos.line;
        const ls = lines();
        const t = ls[idx] ?? "";
        return {
          lineNumber: idx,
          text: t,
          range: new Range(idx, 0, idx, t.length),
          rangeIncludingLineBreak: new Range(idx, 0, idx + 1, 0),
          firstNonWhitespaceCharacterIndex: Math.max(0, t.search(/\S/)),
          isEmptyOrWhitespace: t.trim().length === 0,
        };
      },
      offsetAt,
      positionAt,
      getText(range) {
        if (!range) return content;
        return content.slice(offsetAt(range.start), offsetAt(range.end));
      },
      getWordRangeAtPosition(pos) {
        const l = doc.lineAt(pos).text;
        const m = /\w+/.exec(l.slice(Math.max(0, pos.character - 32)));
        if (!m) return undefined;
        return new Range(pos.line, pos.character, pos.line, pos.character + m[0].length);
      },
      validateRange: (r) => r,
      validatePosition: (p) => p,
      save: async () => {
        if (uri.scheme === "file" && uri.fsPath) {
          await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fsp.writeFile(uri.fsPath, content, "utf8");
          docSaveEmitter.fire(doc);
          return true;
        }
        return false;
      },
      _updateText(nextText) {
        content = String(nextText ?? "");
        doc.version += 1;
      },
    };
    return doc;
  }

  function guessLanguageId(p) {
    const ext = path.extname(p || "").toLowerCase();
    const map = {
      ".js": "javascript", ".cjs": "javascript", ".mjs": "javascript",
      ".ts": "typescript", ".tsx": "typescriptreact", ".jsx": "javascriptreact",
      ".py": "python", ".rs": "rust", ".go": "go", ".java": "java", ".kt": "kotlin",
      ".json": "json", ".md": "markdown", ".sh": "shellscript", ".css": "css",
      ".html": "html", ".xml": "xml", ".yml": "yaml", ".yaml": "yaml", ".c": "c", ".cpp": "cpp",
    };
    return map[ext] || "plaintext";
  }

  async function readUriContent(uri) {
    if (!uri) return "";
    const u = typeof uri === "string" ? Uri.parse(uri) : uri;
    if (fsProviders.has(u.scheme)) {
      const prov = fsProviders.get(u.scheme);
      const data = await Promise.resolve(prov.readFile ? prov.readFile(u) : (prov.stat && prov.stat(u)?.data));
      if (data) return Buffer.from(data).toString("utf8");
    }
    if (contentProviders.has(u.scheme)) {
      const prov = contentProviders.get(u.scheme);
      const txt = await Promise.resolve(prov.provideTextDocumentContent(u, new CancellationTokenSource().token));
      return String(txt ?? "");
    }
    if (u.scheme === "file" && u.fsPath) {
      return await fsp.readFile(u.fsPath, "utf8");
    }
    return "";
  }

  const workspaceFs = {
    stat: async (uri) => {
      if (fsProviders.has(uri.scheme)) {
        return await Promise.resolve(fsProviders.get(uri.scheme).stat(uri));
      }
      try {
        const st = await fsp.stat(uri.fsPath);
        return {
          type: st.isDirectory() ? FileType.Directory : FileType.File,
          ctime: st.ctimeMs,
          mtime: st.mtimeMs,
          size: st.size,
        };
      } catch (e) {
        throw FileSystemError.FileNotFound(uri);
      }
    },
    readFile: async (uri) => {
      if (fsProviders.has(uri.scheme)) {
        const p = fsProviders.get(uri.scheme);
        if (typeof p.readFile === "function") return await Promise.resolve(p.readFile(uri));
        const st = await Promise.resolve(p.stat(uri));
        if (st && st.data) return st.data;
      }
      try {
        return new Uint8Array(await fsp.readFile(uri.fsPath));
      } catch (_) {
        throw FileSystemError.FileNotFound(uri);
      }
    },
    writeFile: async (uri, content) => {
      if (fsProviders.has(uri.scheme)) {
        const p = fsProviders.get(uri.scheme);
        if (typeof p.writeFile === "function") {
          return await Promise.resolve(p.writeFile(uri, content, { create: true, overwrite: true }));
        }
      }
      await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fsp.writeFile(uri.fsPath, Buffer.from(content));
    },
    delete: async (uri, opts) => {
      if (fsProviders.has(uri.scheme)) {
        const p = fsProviders.get(uri.scheme);
        if (typeof p.delete === "function") return await Promise.resolve(p.delete(uri, opts || {}));
      }
      await fsp.rm(uri.fsPath, { recursive: !!(opts && opts.recursive), force: true });
    },
    rename: async (oldUri, newUri, opts) => {
      await fsp.mkdir(path.dirname(newUri.fsPath), { recursive: true });
      await fsp.rename(oldUri.fsPath, newUri.fsPath);
    },
    copy: async (src, dst, opts) => {
      await fsp.mkdir(path.dirname(dst.fsPath), { recursive: true });
      await fsp.cp(src.fsPath, dst.fsPath, { recursive: true, force: !!(opts && opts.overwrite) });
    },
    createDirectory: async (uri) => {
      await fsp.mkdir(uri.fsPath, { recursive: true });
    },
    readDirectory: async (uri) => {
      const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((e) => [
        e.name,
        e.isDirectory() ? FileType.Directory : (e.isSymbolicLink() ? FileType.SymbolicLink : FileType.File),
      ]);
    },
    isWritableFileSystem: () => true,
  };

  async function walkWorkspaceFiles(maxResults = 1500) {
    const out = [];
    const root = currentWorkspaceDir;
    if (!root || !fs.existsSync(root)) return out;
    const skip = new Set([".git", "node_modules", "build-out", ".gradle", "target", "__pycache__", ".next", "dist"]);
    async function walk(dir, depth) {
      if (depth > 8 || out.length >= maxResults) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const ent of entries) {
        if (out.length >= maxResults) break;
        if (skip.has(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          await walk(full, depth + 1);
        } else if (ent.isFile()) {
          out.push(Uri.file(full));
        }
      }
    }
    await walk(root, 0);
    return out;
  }

  const workspace = {
    get workspaceFolders() { return makeWorkspaceFolders(); },
    get rootPath() { return currentWorkspaceDir; },
    workspaceFile: undefined,
    isTrusted: true,
    onDidGrantWorkspaceTrust: new EventEmitter().event,
    onDidChangeWorkspaceFolders: workspaceFoldersEmitter.event,
    onDidChangeConfiguration: configChangeEmitter.event,
    onDidOpenTextDocument: docOpenEmitter.event,
    onDidChangeTextDocument: docChangeEmitter.event,
    onDidCloseTextDocument: docCloseEmitter.event,
    onDidSaveTextDocument: docSaveEmitter.event,
    onWillSaveTextDocument: docWillSaveEmitter.event,
    get textDocuments() { return Array.from(openDocuments.values()); },
    notebookDocuments: [],
    fs: workspaceFs,
    getWorkspaceFolder(uri) {
      const folders = makeWorkspaceFolders();
      if (!folders.length || !uri) return undefined;
      const p = uri.fsPath || uri.path || "";
      if (p === currentWorkspaceDir || p.startsWith(currentWorkspaceDir + "/")) {
        return folders[0];
      }
      return folders[0];
    },
    asRelativePath(pathOrUri) {
      const p = typeof pathOrUri === "string" ? pathOrUri : (pathOrUri.fsPath || pathOrUri.path || "");
      if (currentWorkspaceDir && p.startsWith(currentWorkspaceDir + "/")) {
        return p.slice(currentWorkspaceDir.length + 1);
      }
      return p;
    },
    getConfiguration(section) {
      const prefix = section ? section + "." : "";
      return {
        get(key, defaultValue) {
          const full = prefix + key;
          if (Object.prototype.hasOwnProperty.call(configData, full)) {
            return configData[full];
          }
          // VS Code falls back to the default the extension declares in package.json.
          if (defaultValue === undefined && Object.prototype.hasOwnProperty.call(contributedDefaults, full)) {
            return contributedDefaults[full];
          }
          return defaultValue;
        },
        has(key) {
          return Object.prototype.hasOwnProperty.call(configData, prefix + key)
            || Object.prototype.hasOwnProperty.call(contributedDefaults, prefix + key);
        },
        inspect(key) {
          const full = prefix + key;
          const val = configData[full];
          return { key: full, globalValue: val, workspaceValue: undefined, defaultValue: contributedDefaults[full] };
        },
        update: async (key, value) => {
          updateHostSetting(prefix + key, value);
        },
      };
    },
    registerFileSystemProvider(scheme, provider) {
      fsProviders.set(scheme, provider);
      return new Disposable(() => fsProviders.delete(scheme));
    },
    registerTextDocumentContentProvider(scheme, provider) {
      contentProviders.set(scheme, provider);
      return new Disposable(() => contentProviders.delete(scheme));
    },
    async openTextDocument(uriOrFileName) {
      const uri = typeof uriOrFileName === "string"
        ? Uri.file(uriOrFileName)
        : (uriOrFileName instanceof Uri ? uriOrFileName : Uri.file(String(uriOrFileName?.path || "")));
      const key = uri.toString();
      const txt = await readUriContent(uri).catch(() => "");
      if (openDocuments.has(key)) {
        const existing = openDocuments.get(key);
        existing._updateText(txt);
        return existing;
      }
      const doc = createTextDocument(uri, txt);
      openDocuments.set(key, doc);
      docOpenEmitter.fire(doc);
      return doc;
    },
    async findFiles(includePattern, _excludePattern, maxResults) {
      const all = await walkWorkspaceFiles(maxResults || 1500);
      if (!includePattern || typeof includePattern !== "string" || includePattern === "**/*") {
        return all;
      }
      const needle = includePattern.replace(/^\*\*\/?/, "").replace(/\*/g, "").toLowerCase();
      if (!needle) return all;
      return all.filter((u) => u.fsPath.toLowerCase().includes(needle));
    },
    async applyEdit(edit) {
      if (!edit || !Array.isArray(edit._ops)) return true;
      for (const op of edit._ops) {
        try {
          if (op.kind === "create") {
            await fsp.mkdir(path.dirname(op.uri.fsPath), { recursive: true });
            if (!fs.existsSync(op.uri.fsPath) || op.options.overwrite) {
              await fsp.writeFile(op.uri.fsPath, "", "utf8");
            }
          } else if (op.kind === "delete") {
            await fsp.rm(op.uri.fsPath, { recursive: !!op.options.recursive, force: true });
          } else if (op.kind === "rename") {
            await fsp.mkdir(path.dirname(op.newUri.fsPath), { recursive: true });
            await fsp.rename(op.oldUri.fsPath, op.newUri.fsPath);
          }
        } catch (err) {
          log("[vscode-shim] applyEdit file op error:", err.message);
        }
      }
      for (const [uri, edits] of edit.entries()) {
        try {
          const doc = await workspace.openTextDocument(uri);
          let text = doc.getText();
          const sorted = edits.slice().sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start));
          for (const te of sorted) {
            const s = doc.offsetAt(te.range.start);
            const e = doc.offsetAt(te.range.end);
            text = text.slice(0, s) + (te.newText || "") + text.slice(e);
          }
          doc._updateText(text);
          if (uri.scheme === "file" && uri.fsPath) {
            await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
            await fsp.writeFile(uri.fsPath, text, "utf8");
          }
        } catch (err) {
          log("[vscode-shim] applyEdit text error:", err.message);
        }
      }
      return true;
    },
    createFileSystemWatcher(globPattern) {
      const createEmitter = new EventEmitter();
      const changeEmitter = new EventEmitter();
      const deleteEmitter = new EventEmitter();
      let watcher = null;
      try {
        if (globPattern && typeof globPattern === "object" && globPattern.base) {
          const watchDir = globPattern.base;
          const targetName = String(globPattern.pattern || "").replace(/^\*\*\//, "");
          if (fs.existsSync(watchDir)) {
            watcher = fs.watch(watchDir, { persistent: false }, (eventType, filename) => {
              if (!filename) return;
              if (targetName && targetName !== "*" && !targetName.includes("*") && filename !== targetName) {
                return;
              }
              const full = Uri.file(path.join(watchDir, filename));
              if (eventType === "rename") {
                if (fs.existsSync(full.fsPath)) createEmitter.fire(full);
                else deleteEmitter.fire(full);
              } else {
                changeEmitter.fire(full);
              }
            });
          }
        }
      } catch (_) {}
      return {
        onDidCreate: createEmitter.event,
        onDidChange: changeEmitter.event,
        onDidDelete: deleteEmitter.event,
        dispose: () => {
          try { if (watcher) watcher.close(); } catch (_) {}
          createEmitter.dispose();
          changeEmitter.dispose();
          deleteEmitter.dispose();
        },
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Commands, Window, Webview Panels & Views
  // ---------------------------------------------------------------------------
  const commandsMap = new Map();
  const contextKeys = new Map();

  // Built-in VS Code commands invoked by extension.js
  commandsMap.set("setContext", (key, val) => {
    contextKeys.set(key, val);
    return undefined;
  });
  commandsMap.set("workbench.action.newGroupRight", async () => undefined);
  commandsMap.set("workbench.action.newGroupBelow", async () => undefined);
  commandsMap.set("workbench.action.moveEditorToNewWindow", async () => undefined);
  commandsMap.set("workbench.action.openWalkthrough", async () => undefined);
  commandsMap.set("workbench.action.reopenClosedEditor", async () => undefined);
  commandsMap.set("workbench.action.closeActiveEditor", async () => undefined);
  // The chat's official "Settings" links (e.g. openSettings("claudeCode")) open the app's Settings.
  commandsMap.set("workbench.action.openSettings", async (query) => {
    onOpenSettings(typeof query === "string" ? query : (query && query.query) || "");
    return undefined;
  });
  commandsMap.set("claudeVSCodeSidebar.focus", async () => undefined);
  commandsMap.set("claudeVSCodeSidebarSecondary.focus", async () => undefined);

  const previewTabs = [];
  function closePreviewTabById(tabId) {
    const idx = previewTabs.findIndex((t) => t._id === tabId);
    if (idx !== -1) {
      const removed = previewTabs.splice(idx, 1)[0];
      if (removed && removed._uriKey && openDocuments.has(removed._uriKey)) {
        const doc = openDocuments.get(removed._uriKey);
        doc.isClosed = true;
        openDocuments.delete(removed._uriKey);
        docCloseEmitter.fire(doc);
      }
      tabChangeEmitter.fire({ opened: [], closed: [removed], changed: [] });
      return true;
    }
    return false;
  }

  commandsMap.set("vscode.diff", async (leftUri, rightUri, title) => {
    const leftText = await readUriContent(leftUri).catch(() => "");
    const rightText = await readUriContent(rightUri).catch(() => "");
    while (previewTabs.length >= 30 && previewTabs[0] && previewTabs[0]._id) {
      closePreviewTabById(previewTabs[0]._id);
    }
    const tabId = "diff-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    const tabObj = {
      _id: tabId,
      label: title || "Diff",
      isActive: true,
      isDirty: false,
      isPinned: false,
      isPreview: true,
      group: null,
      input: new TabInputTextDiff(leftUri, rightUri),
    };
    previewTabs.push(tabObj);
    tabChangeEmitter.fire({ opened: [tabObj], closed: [], changed: [] });
    onOpenPreview({
      kind: "diff",
      tabId,
      title: title || path.basename(rightUri?.path || "Diff"),
      filePath: rightUri?.fsPath || rightUri?.path || "",
      leftText,
      rightText,
      leftContent: leftText,
      rightContent: rightText,
    });
    return undefined;
  });

  const commands = {
    registerCommand(id, handler, thisArg) {
      commandsMap.set(id, thisArg ? handler.bind(thisArg) : handler);
      return new Disposable(() => commandsMap.delete(id));
    },
    registerTextEditorCommand(id, handler, thisArg) {
      commandsMap.set(id, thisArg ? handler.bind(thisArg) : handler);
      return new Disposable(() => commandsMap.delete(id));
    },
    async executeCommand(id, ...args) {
      const fn = commandsMap.get(id);
      if (fn) {
        return await fn(...args);
      }
      return undefined;
    },
    async getCommands() {
      return Array.from(commandsMap.keys());
    },
  };

  let panelSeq = 0;
  const panels = new Map();
  let activePanelId = null;
  const webviewViewProviders = new Map();
  const panelSerializers = new Map();
  const uriHandlers = new Set();
  const tabChangeEmitter = new EventEmitter();
  const tabGroupChangeEmitter = new EventEmitter();

  function createWebviewObject(panelId) {
    const msgEmitter = new EventEmitter();
    let htmlValue = "";
    let optionsValue = {};
    const cspOrigin = `http://127.0.0.1:${port} http://localhost:${port} ws://127.0.0.1:${port} ws://localhost:${port} data: blob:`;
    return {
      get options() { return optionsValue; },
      set options(v) { optionsValue = v || {}; },
      get html() { return htmlValue; },
      set html(v) { htmlValue = String(v || ""); },
      cspSource: cspOrigin,
      onDidReceiveMessage: msgEmitter.event,
      asWebviewUri(localResource) {
        const fsP = localResource?.fsPath || localResource?.path || "";
        const normExt = path.resolve(extensionPath);
        const normRes = path.resolve(fsP);
        if (normRes === normExt || normRes.startsWith(normExt + path.sep)) {
          const rel = normRes.slice(normExt.length + 1).split(path.sep).map(encodeURIComponent).join("/");
          return Uri.parse(`http://127.0.0.1:${port}/ext/${rel}`);
        }
        return Uri.parse(`http://127.0.0.1:${port}/api/fs/raw?path=${encodeURIComponent(normRes)}`);
      },
      async postMessage(message) {
        onPanelMessage(panelId, message);
        return true;
      },
      _receiveFromClient(message) {
        msgEmitter.fire(message);
      },
      _dispose() {
        msgEmitter.dispose();
      },
    };
  }

  function buildTabGroupSnapshot() {
    const panelTabs = Array.from(panels.values()).map((p) => ({
      _id: p.id,
      _panel: p,
      label: p.title || "Claude Code",
      isActive: p.id === activePanelId,
      isDirty: false,
      isPinned: false,
      isPreview: false,
      input: new TabInputWebview(p.viewType),
    }));
    const allTabs = [...panelTabs, ...previewTabs];
    const group = {
      isActive: true,
      viewColumn: ViewColumn.One,
      activeTab: allTabs.find((t) => t.isActive) || allTabs[0],
      tabs: allTabs,
    };
    for (const t of allTabs) t.group = group;
    return group;
  }

  const tabGroups = {
    get all() { return [buildTabGroupSnapshot()]; },
    get activeTabGroup() { return buildTabGroupSnapshot(); },
    onDidChangeTabs: tabChangeEmitter.event,
    onDidChangeTabGroups: tabGroupChangeEmitter.event,
    async close(tabOrTabs) {
      const list = Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs];
      for (const t of list) {
        if (!t) continue;
        if (t._panel) t._panel.dispose();
        else if (t._id) closePreviewTabById(t._id);
      }
      return true;
    },
  };

  const activeEditorEmitter = new EventEmitter();
  const visibleEditorsEmitter = new EventEmitter();
  const selectionChangeEmitter = new EventEmitter();
  const termShellStartEmitter = new EventEmitter();
  const termShellEndEmitter = new EventEmitter();
  const termShellIntegrationEmitter = new EventEmitter();
  const windowStateEmitter = new EventEmitter();
  const terminals = [];

  // VS Code semantics: a message with buttons resolves to the button the *user* clicked,
  // or undefined when dismissed. Never auto-pick a button on the user's behalf.
  async function safeUserPrompt(payload) {
    try {
      return await onUserPrompt(payload);
    } catch (_) {
      return undefined;
    }
  }

  async function askUserMessage(level, message, rest) {
    let options = null;
    let items = rest;
    if (rest.length > 0 && rest[0] && typeof rest[0] === "object" && typeof rest[0].title !== "string") {
      options = rest[0];
      items = rest.slice(1);
    }
    const actions = items.filter((x) => typeof x === "string" || (x && typeof x.title === "string"));
    const text = String(message == null ? "" : message);
    if (actions.length === 0) {
      onShowMessage(level, text);
      return undefined;
    }
    const picked = await safeUserPrompt({
      kind: "message",
      level,
      message: text,
      detail: options && options.detail ? String(options.detail) : "",
      modal: Boolean(options && options.modal),
      items: actions.map((a) => (typeof a === "string" ? a : a.title)),
    });
    if (typeof picked !== "number" || picked < 0 || picked >= actions.length) return undefined;
    return actions[picked];
  }

  const windowObj = {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    activeNotebookEditor: undefined,
    visibleNotebookEditors: [],
    terminals,
    activeTerminal: undefined,
    state: { focused: true, active: true, onDidChange: windowStateEmitter.event },
    onDidChangeWindowState: windowStateEmitter.event,
    tabGroups,
    onDidChangeActiveTextEditor: activeEditorEmitter.event,
    onDidChangeVisibleTextEditors: visibleEditorsEmitter.event,
    onDidChangeTextEditorSelection: selectionChangeEmitter.event,
    onDidStartTerminalShellExecution: termShellStartEmitter.event,
    onDidEndTerminalShellExecution: termShellEndEmitter.event,
    onDidChangeTerminalShellIntegration: termShellIntegrationEmitter.event,

    createOutputChannel(name) {
      return {
        name,
        append: (v) => log(`[ext:${name}]`, String(v).trimEnd()),
        appendLine: (v) => log(`[ext:${name}]`, v),
        replace: () => {},
        clear: () => {},
        show: () => {},
        hide: () => {},
        info: (...a) => log(`[ext:${name}:INFO]`, ...a),
        warn: (...a) => log(`[ext:${name}:WARN]`, ...a),
        error: (...a) => log(`[ext:${name}:ERROR]`, ...a),
        debug: () => {},
        trace: () => {},
        logLevel: 2,
        onDidChangeLogLevel: new EventEmitter().event,
        dispose: () => {},
      };
    },

    createStatusBarItem() {
      return {
        text: "",
        tooltip: "",
        command: undefined,
        color: undefined,
        backgroundColor: undefined,
        show: () => {},
        hide: () => {},
        dispose: () => {},
      };
    },

    setStatusBarMessage() {
      return new Disposable(() => {});
    },

    createTextEditorDecorationType() {
      return { key: "dec-" + Math.random().toString(36).slice(2, 7), dispose: () => {} };
    },

    registerWebviewViewProvider(viewId, provider) {
      webviewViewProviders.set(viewId, provider);
      return new Disposable(() => webviewViewProviders.delete(viewId));
    },

    registerWebviewPanelSerializer(viewType, serializer) {
      panelSerializers.set(viewType, serializer);
      return new Disposable(() => panelSerializers.delete(viewType));
    },

    registerUriHandler(handler) {
      uriHandlers.add(handler);
      return new Disposable(() => uriHandlers.delete(handler));
    },

    createWebviewPanel(viewType, title, showOptions, options) {
      const id = "panel-" + (++panelSeq);
      const disposeEmitter = new EventEmitter();
      const viewStateEmitter = new EventEmitter();
      const webview = createWebviewObject(id);
      if (options) webview.options = options;

      let currentTitle = title || "Claude Code";
      let disposed = false;
      const col = typeof showOptions === "number" ? showOptions : (showOptions?.viewColumn || ViewColumn.One);

      const panel = {
        id,
        viewType,
        get title() { return currentTitle; },
        set title(v) { currentTitle = String(v || "Claude Code"); },
        iconPath: undefined,
        webview,
        options: options || {},
        viewColumn: col,
        get active() { return activePanelId === id; },
        get visible() { return !disposed; },
        onDidDispose: disposeEmitter.event,
        onDidChangeViewState: viewStateEmitter.event,
        reveal() {
          if (disposed) return;
          const prev = activePanelId;
          activePanelId = id;
          if (prev !== id) {
            viewStateEmitter.fire({ webviewPanel: panel });
          }
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          panels.delete(id);
          if (activePanelId === id) {
            const keys = Array.from(panels.keys());
            activePanelId = keys.length ? keys[keys.length - 1] : null;
          }
          webview._dispose();
          disposeEmitter.fire(undefined);
          disposeEmitter.dispose();
          viewStateEmitter.dispose();
          onPanelDisposed(id);
        },
      };

      panels.set(id, panel);
      activePanelId = id;
      onPanelCreated(panel);
      return panel;
    },

    async showTextDocument(docOrUri) {
      const doc = docOrUri && docOrUri.getText ? docOrUri : await workspace.openTextDocument(docOrUri);
      while (previewTabs.length >= 30 && previewTabs[0] && previewTabs[0]._id) {
        closePreviewTabById(previewTabs[0]._id);
      }
      const tabId = "doc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
      const tabObj = {
        _id: tabId,
        _uriKey: doc.uri.toString(),
        label: path.basename(doc.uri.path || "Document"),
        isActive: true,
        isDirty: false,
        isPinned: false,
        isPreview: true,
        group: null,
        input: new TabInputText(doc.uri),
      };
      previewTabs.push(tabObj);
      tabChangeEmitter.fire({ opened: [tabObj], closed: [], changed: [] });
      onOpenPreview({
        kind: "file",
        tabId,
        title: path.basename(doc.uri.path || "File"),
        filePath: doc.uri.fsPath || doc.uri.path || "",
        content: doc.getText(),
        languageId: doc.languageId,
      });
      const editor = {
        document: doc,
        selection: new Selection(0, 0, 0, 0),
        selections: [new Selection(0, 0, 0, 0)],
        visibleRanges: [new Range(0, 0, Math.max(0, doc.lineCount - 1), 0)],
        options: {},
        viewColumn: ViewColumn.One,
        edit: async () => true,
        setDecorations: () => {},
        revealRange: () => {},
        show: () => {},
        hide: () => {},
      };
      return editor;
    },

    showInformationMessage(message, ...rest) {
      return askUserMessage("info", message, rest);
    },
    showWarningMessage(message, ...rest) {
      return askUserMessage("warn", message, rest);
    },
    showErrorMessage(message, ...rest) {
      return askUserMessage("error", message, rest);
    },
    async showQuickPick(items, options) {
      const resolved = await Promise.resolve(items);
      if (!Array.isArray(resolved) || resolved.length === 0) return undefined;
      const opts = options || {};
      const labels = resolved.map((it) => (typeof it === "string" ? it : String((it && it.label) || "")));
      const descriptions = resolved.map((it) => (it && typeof it === "object" && it.description ? String(it.description) : ""));
      const picked = await safeUserPrompt({
        kind: "quickpick",
        title: opts.title ? String(opts.title) : "",
        placeHolder: opts.placeHolder ? String(opts.placeHolder) : "",
        items: labels,
        descriptions,
        modal: true,
      });
      if (typeof picked !== "number" || picked < 0 || picked >= resolved.length) return undefined;
      return opts.canPickMany ? [resolved[picked]] : resolved[picked];
    },
    async showInputBox(options) {
      const opts = options || {};
      let value = typeof opts.value === "string" ? opts.value : "";
      let validationMessage = "";
      for (let attempt = 0; attempt < 6; attempt++) {
        const typed = await safeUserPrompt({
          kind: "input",
          title: opts.title ? String(opts.title) : "",
          prompt: opts.prompt ? String(opts.prompt) : "",
          placeHolder: opts.placeHolder ? String(opts.placeHolder) : "",
          password: opts.password === true,
          value,
          validationMessage,
          modal: true,
        });
        if (typeof typed !== "string") return undefined;
        if (typeof opts.validateInput !== "function") return typed;
        let verdict;
        try { verdict = await Promise.resolve(opts.validateInput(typed)); } catch (_) { verdict = undefined; }
        const msg = verdict && typeof verdict === "object" ? verdict.message : verdict;
        if (!msg) return typed;
        value = typed;
        validationMessage = String(msg);
      }
      return undefined;
    },
    async showOpenDialog() {
      return undefined;
    },
    async showSaveDialog() {
      return undefined;
    },
    async withProgress(_options, task) {
      const progress = { report: () => {} };
      const cts = new CancellationTokenSource();
      try {
        return await task(progress, cts.token);
      } finally {
        cts.dispose();
      }
    },

    createTerminal(opts = {}) {
      const term = {
        name: opts.name || "Claude Terminal",
        processId: Promise.resolve(process.pid),
        creationOptions: opts,
        exitStatus: undefined,
        state: { isInteractedWith: true },
        shellIntegration: undefined,
        sendText(text) {
          onOpenPreview({
            kind: "terminal",
            title: term.name,
            command: text,
            cwd: opts.cwd || currentWorkspaceDir,
          });
        },
        show() {
          onOpenPreview({
            kind: "terminal",
            title: term.name,
            command: "",
            cwd: opts.cwd || currentWorkspaceDir,
          });
        },
        hide() {},
        dispose() {
          const i = terminals.indexOf(term);
          if (i !== -1) terminals.splice(i, 1);
        },
      };
      if (terminals.length >= 20) terminals.shift();
      terminals.push(term);
      windowObj.activeTerminal = term;
      return term;
    },
  };

  // ---------------------------------------------------------------------------
  // env, languages, comments, extensions
  // ---------------------------------------------------------------------------
  let clipboardText = "";
  const telemetryEmitter = new EventEmitter();
  const machineIdPath = path.join(storageDir, "machine-id");
  let machineId = "";
  try {
    if (fs.existsSync(machineIdPath)) machineId = fs.readFileSync(machineIdPath, "utf8").trim();
  } catch (_) {}
  if (!machineId) {
    machineId = crypto.randomBytes(32).toString("hex");
    try { fs.writeFileSync(machineIdPath, machineId, { mode: 0o600 }); } catch (_) {}
  }

  const env = {
    appName: "Claude Code Android",
    appRoot: extensionPath,
    language: "es",
    clipboard: {
      readText: async () => clipboardText,
      writeText: async (v) => { clipboardText = String(v || ""); },
    },
    machineId,
    sessionId: crypto.randomUUID(),
    isNewAppInstall: false,
    isTelemetryEnabled: false,
    onDidChangeTelemetryEnabled: telemetryEmitter.event,
    remoteName: undefined,
    shell: process.env.SHELL || "/system/bin/sh",
    uiKind: UIKind.Desktop,
    uriScheme: process.env.CC_OAUTH_SCHEME || "claudecode",
    async openExternal(target) {
      const urlStr = typeof target === "string" ? target : target.toString(true);
      const handledByUi = Boolean(onOpenExternal(urlStr));
      if (!handledByUi) {
        const xdg = process.env.BROWSER || "xdg-open";
        try {
          const child = spawn(xdg, [urlStr], { stdio: "ignore", detached: true });
          child.unref();
        } catch (_) {}
      }
      return true;
    },
    asExternalUri: async (u) => u,
  };

  const diagEmitter = new EventEmitter();
  const languages = {
    onDidChangeDiagnostics: diagEmitter.event,
    getDiagnostics: () => [],
    createDiagnosticCollection: (name) => ({
      name,
      set: () => {},
      delete: () => {},
      clear: () => {},
      forEach: () => {},
      get: () => [],
      has: () => false,
      dispose: () => {},
    }),
    registerCodeLensProvider: () => new Disposable(() => {}),
    registerHoverProvider: () => new Disposable(() => {}),
    registerCodeActionsProvider: () => new Disposable(() => {}),
    match: () => 0,
  };

  const comments = {
    createCommentController(id, label) {
      return {
        id,
        label,
        commentingRangeProvider: undefined,
        options: undefined,
        createCommentThread: (uri, range, threadComments) => ({
          uri,
          range,
          comments: threadComments || [],
          collapsibleState: CommentThreadCollapsibleState.Expanded,
          canReply: true,
          state: CommentThreadState.Unresolved,
          dispose: () => {},
        }),
        dispose: () => {},
      };
    },
  };

  const pkgJson = JSON.parse(fs.readFileSync(path.join(extensionPath, "package.json"), "utf8"));
  const selfExtension = {
    id: "Anthropic.claude-code",
    extensionUri: Uri.file(extensionPath),
    extensionPath,
    isActive: true,
    packageJSON: pkgJson,
    extensionKind: 1,
    exports: undefined,
    activate: async () => selfExtension.exports,
  };

  const extensions = {
    all: [selfExtension],
    getExtension(id) {
      if (String(id).toLowerCase() === "anthropic.claude-code") return selfExtension;
      return undefined;
    },
    onDidChange: new EventEmitter().event,
  };

  // ---------------------------------------------------------------------------
  // ExtensionContext Factory
  // ---------------------------------------------------------------------------
  function createExtensionContext() {
    const globalStoragePath = path.join(storageDir, "globalStorage");
    const workspaceStoragePath = path.join(storageDir, "workspaceStorage");
    const logPath = path.join(storageDir, "logs");
    fs.mkdirSync(globalStoragePath, { recursive: true });
    fs.mkdirSync(workspaceStoragePath, { recursive: true });
    fs.mkdirSync(logPath, { recursive: true });

    const globalState = createJsonMemento(path.join(storageDir, "globalState.json"), {
      walkthroughShown: Date.now(),
      lastClaudeLocationMigrated: true,
      settingsMigrated20251024: true,
      preferredLocation: "panel",
      // "Prefer the Terminal experience?" refers to VS Code's integrated terminal mode,
      // which does not exist on Android.
      showTerminalBanner: false,
    });
    const workspaceState = createJsonMemento(path.join(storageDir, "workspaceState.json"), {});
    const secrets = createSecretStorage(path.join(storageDir, "secrets.json"));

    return {
      subscriptions: [],
      workspaceState,
      globalState,
      secrets,
      extensionUri: Uri.file(extensionPath),
      extensionPath,
      environmentVariableCollection: {
        persistent: true,
        description: "",
        replace: () => {},
        append: () => {},
        prepend: () => {},
        get: () => undefined,
        forEach: () => {},
        delete: () => {},
        clear: () => {},
        getScoped: () => ({ replace: () => {}, append: () => {}, prepend: () => {}, clear: () => {} }),
      },
      asAbsolutePath(relPath) {
        const normRel = String(relPath || "").replace(/\\/g, "/");
        if (hostOpts.claudeBinaryPath && (normRel === "resources/native-binary/claude" || normRel.endsWith("/native-binary/claude"))) {
          return hostOpts.claudeBinaryPath;
        }
        return path.join(extensionPath, relPath);
      },
      storageUri: Uri.file(workspaceStoragePath),
      storagePath: workspaceStoragePath,
      globalStorageUri: Uri.file(globalStoragePath),
      globalStoragePath,
      logUri: Uri.file(logPath),
      logPath,
      extensionMode: ExtensionMode.Production,
      extension: selfExtension,
      languageModelAccessInformation: {
        onDidChange: new EventEmitter().event,
        canSendRequest: () => true,
      },
    };
  }

  const vscodeApi = {
    version: "1.106.0",
    Disposable,
    EventEmitter,
    CancellationTokenSource,
    Uri,
    Position,
    Range,
    Selection,
    Location,
    RelativePattern,
    TextEdit,
    WorkspaceEdit,
    FileSystemError,
    ThemeIcon,
    ThemeColor,
    MarkdownString,
    TabInputText,
    TabInputTextDiff,
    TabInputCustom,
    TabInputWebview,
    TabInputNotebook,
    TabInputNotebookDiff,
    TabInputTerminal,
    ViewColumn,
    ExtensionMode,
    ConfigurationTarget,
    UIKind,
    FileType,
    FileChangeType,
    EndOfLine,
    StatusBarAlignment,
    ProgressLocation,
    TextDocumentChangeReason,
    TextDocumentSaveReason,
    TextEditorSelectionChangeKind,
    TextEditorRevealType,
    CommentThreadCollapsibleState,
    CommentThreadState,
    NotebookCellKind,
    NotebookEditorRevealType,
    NotebookCellOutputItem,
    NotebookEdit,
    NotebookRange,
    NotebookCellData,
    DiagnosticSeverity,
    CodeActionKind,
    CodeAction,
    CodeActionTriggerKind,
    workspace,
    window: windowObj,
    commands,
    env,
    languages,
    comments,
    extensions,
  };
  vscodeApi.default = vscodeApi;

  return {
    vscodeApi,
    createExtensionContext,
    getPanels: () => panels,
    getActivePanel: () => (activePanelId ? panels.get(activePanelId) : Array.from(panels.values())[0]),
    setActivePanelId: (id) => {
      if (panels.has(id)) {
        panels.get(id).reveal();
        return true;
      }
      return false;
    },
    getWorkspaceDirectory: () => currentWorkspaceDir,
    setWorkspaceDirectory,
    updateHostSetting,
    getHostSetting: (fullKey) => (Object.prototype.hasOwnProperty.call(configData, fullKey)
      ? configData[fullKey]
      : contributedDefaults[fullKey]),
    getSettingSchema: (fullKey) => contributedSchema[fullKey],
    closePreviewTabById,
    handleDeepLinkUri: (uriStr) => {
      const u = Uri.parse(uriStr);
      for (const h of uriHandlers) {
        try { h.handleUri(u); } catch (_) {}
      }
    },
  };
}

module.exports = { createVSCodeShim };
