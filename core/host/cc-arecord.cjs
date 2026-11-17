#!/usr/bin/env node
"use strict";

/**
 * cc-arecord.cjs — `arecord` stand-in for Claude Code voice dictation on Android.
 *
 * The official extension spawns `arecord -q -f S16_LE -r 16000 -c 1 -t raw` and reads
 * raw PCM from stdout. Android has no ALSA, so this asks the Claude Code app (which
 * records with AudioRecord) over a private abstract socket. The app only accepts
 * connections from its own uid that present the per-boot token the host injects into
 * the extension's own spawn of arecord.
 */

const net = require("net");

const socketName = process.env.CC_MIC_SOCKET || "";
const token = process.env.CC_MIC_TOKEN || "";

if (!socketName || !token) {
  process.stderr.write("arecord: the microphone is only available to Claude Code voice dictation\n");
  process.exit(1);
}

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  try { conn.destroy(); } catch (_) {}
  process.exit(code);
}

const conn = net.createConnection({ path: "\0" + socketName });
conn.on("connect", () => conn.write(token + "\n"));
conn.on("error", (err) => {
  process.stderr.write("arecord: " + err.message + "\n");
  finish(1);
});
conn.on("close", () => finish(0));
conn.pipe(process.stdout);

process.stdout.on("error", () => finish(0));
process.on("SIGTERM", () => finish(0));
process.on("SIGINT", () => finish(0));
