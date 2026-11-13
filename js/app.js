import { FFmpeg } from "../vendor/ffmpeg/index.js";
import { FORMATS, GROUP_LABELS, buildArgs, extFor, extensionOf, guessKind, isHeif, targetsFor } from "./formats.js";

const url = (path) => new URL(path, import.meta.url).href;
const CORES = {
  single: {
    coreURL: url("../vendor/core/ffmpeg-core.js"),
    wasmURL: url("../vendor/core/ffmpeg-core.wasm"),
  },
  multi: {
    coreURL: url("../vendor/core-mt/ffmpeg-core.js"),
    wasmURL: url("../vendor/core-mt/ffmpeg-core.wasm"),
    workerURL: url("../vendor/core-mt/ffmpeg-core.worker.js"),
  },
};
// Threads need SharedArrayBuffer, which browsers only expose on cross-origin
// isolated pages. coi-serviceworker.js provides that on plain static hosts.
let threads = self.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined"
  ? Math.max(2, Math.min(navigator.hardwareConcurrency || 2, 8))
  : 0;
const IN_DIR = "/in";
const SOFT_SIZE_LIMIT = 2 * 1024 ** 3; // 32-bit WebAssembly memory ceiling

const $ = (id) => document.getElementById(id);
const el = {
  drop: $("drop"), file: $("file"), work: $("work"),
  fname: $("fname"), fmeta: $("fmeta"), change: $("change"),
  opts: $("opts"), format: $("format"), quality: $("quality"), height: $("height"),
  start: $("start"), end: $("end"), mute: $("mute"), extra: $("extra"), cmd: $("cmd"),
  fQuality: $("f-quality"), fHeight: $("f-height"), fStart: $("f-start"), fEnd: $("f-end"), fMute: $("f-mute"),
  go: $("go"), cancel: $("cancel"),
  status: $("status"), statusText: $("status-text"), statusPct: $("status-pct"), bar: $("bar"),
  error: $("error"), result: $("result"), preview: $("preview"),
  rname: $("rname"), rmeta: $("rmeta"), download: $("download"), engine: $("engine"),
  logbox: $("logbox"), log: $("log"),
};

const state = {
  file: null,
  kind: null,       // "video" | "audio" | "image" | null
  ext: "",
  info: null,       // probe result
  input: null,      // { blob, name, args } — what FFmpeg actually reads
  busy: false,
  resultUrl: null,
  token: 0,         // invalidates async work when the file changes
};

/* ------------------------------------------------------------------ */
/* FFmpeg engine                                                       */
/* ------------------------------------------------------------------ */

let ffmpeg = null;
let loading = null;
let logLines = [];
let onLogLine = null;

function ensureLoaded() {
  if (ffmpeg?.loaded) return Promise.resolve();
  if (!loading) {
    ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => {
      logLines.push(message);
      onLogLine?.(message);
    });
    const fm = ffmpeg;
    loading = fm.load(threads ? CORES.multi : CORES.single)
      .catch((err) => {
        if (!threads || fm !== ffmpeg) throw err;
        console.warn("Multi-threaded FFmpeg failed to start; using the single-threaded build.", err);
        threads = 0;
        showEngine();
        fm.terminate();
        return fm.load(CORES.single);
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

function showEngine() {
  el.engine.textContent = threads
    ? `Engine: multi-threaded (${threads} threads).`
    : "Engine: single-threaded.";
}

function killEngine() {
  try { ffmpeg?.terminate(); } catch { /* already gone */ }
  ffmpeg = null;
  loading = null;
}

/** Run ffmpeg with the input mounted read-only (no copy into memory). */
async function run(input, args) {
  await ensureLoaded();
  const fm = ffmpeg;
  await fm.createDir(IN_DIR).catch(() => {});
  await fm.mount("WORKERFS", { blobs: [{ name: input.name, data: input.blob }] }, IN_DIR);
  try {
    return await fm.exec(args);
  } finally {
    if (fm.loaded) await fm.unmount(IN_DIR).catch(() => {});
  }
}

/** Decode a HEIC/HEIF image to raw RGBA pixels in a throwaway worker. */
function decodeHeif(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(url("./heic-worker.js"), { type: "module" });
    const finish = (fn, value) => { worker.terminate(); fn(value); };
    worker.onmessage = ({ data }) =>
      data.error ? finish(reject, new Error(data.error)) : finish(resolve, data);
    worker.onerror = (e) => finish(reject, new Error(e.message || "HEIF decoder failed to load"));
    worker.postMessage(file);
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 2 : 1)} ${units[i]}`;
}

function fmtDuration(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (v) => String(v).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** "90", "1:30", "0:01:30.5" → seconds, or null when invalid. */
function parseTime(text) {
  text = text.trim();
  if (!/^(\d+:){0,2}\d+(\.\d+)?$/.test(text)) return null;
  return text.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

const clockToSeconds = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);

function parseProbe(lines) {
  const info = { duration: null, video: null, audio: null };
  for (const line of lines) {
    let m;
    if (info.duration == null && (m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line))) {
      info.duration = clockToSeconds(m[1], m[2], m[3]);
    } else if ((m = /Stream #\d+:\d+.*?: (Video|Audio): (\w+)(.*)/.exec(line))) {
      if (m[1] === "Video" && !info.video) {
        const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(m[3]);
        info.video = { codec: m[2], size: size ? `${size[1]}×${size[2]}` : null };
      } else if (m[1] === "Audio" && !info.audio) {
        info.audio = { codec: m[2] };
      }
    }
  }
  return info;
}

function show(node, visible) { node.hidden = !visible; }

function setError(message) {
  el.error.textContent = message || "";
  show(el.error, Boolean(message));
}

function setStatus(text, fraction) {
  show(el.status, text != null);
  if (text == null) return;
  el.statusText.textContent = text;
  if (fraction == null) {
    el.bar.removeAttribute("value");
    el.statusPct.textContent = "";
  } else {
    const f = Math.min(1, Math.max(0, fraction));
    el.bar.value = f;
    el.statusPct.textContent = `${Math.round(f * 100)}%`;
  }
}

function clearResult() {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
  el.preview.replaceChildren();
  show(el.result, false);
}

function renderLog() {
  el.log.textContent = logLines.join("\n");
  show(el.logbox, logLines.length > 0);
}

/* ------------------------------------------------------------------ */
/* Options UI                                                          */
/* ------------------------------------------------------------------ */

function fillFormats() {
  const targets = targetsFor(state.kind, state.ext);
  el.format.replaceChildren();
  for (const group of Object.keys(GROUP_LABELS)) {
    const keys = targets.filter((k) => FORMATS[k].group === group);
    if (!keys.length) continue;
    const og = document.createElement("optgroup");
    og.label = GROUP_LABELS[group];
    for (const k of keys) {
      const option = new Option(FORMATS[k].label, k);
      if (FORMATS[k].threads && !threads) {
        option.disabled = true;
        option.text += " — needs multi-threading";
      }
      og.append(option);
    }
    el.format.append(og);
  }
  // Default to the first format that isn't the one we already have.
  const sameExt = state.ext === "jpeg" ? "jpg" : state.ext === "tif" ? "tiff" : state.ext;
  el.format.value = state.heif ? "jpg"
    : targets.find((k) => extFor(k) !== sameExt && !FORMATS[k].threads) ?? targets[0];
}

function fillQuality() {
  const f = FORMATS[el.format.value];
  const previous = el.quality.value || "balanced";
  const options = [["high", "High"], ["balanced", "Balanced"], ["small", "Smaller file"]];
  if (f.remux) options.push(["copy", "Copy streams (fast, no re-encode)"]);
  el.quality.replaceChildren(...options.map(([v, label]) => new Option(label, v)));
  el.quality.value = options.some(([v]) => v === previous) ? previous : "balanced";
}

function currentOptions() {
  return {
    format: el.format.value,
    quality: el.quality.value,
    height: el.height.value,
    mute: el.mute.checked,
    start: el.start.value.trim(),
    end: el.end.value.trim(),
    extra: el.extra.value,
  };
}

function inputName() { return state.input?.name ?? `input${state.ext ? "." + state.ext : ""}`; }
function outputName() { return `output.${extFor(el.format.value)}`; }

function refreshOptions() {
  const f = FORMATS[el.format.value];
  if (!f) return;
  const o = currentOptions();
  const timed = state.kind !== "image" || state.ext === "gif";
  const lossless = ["flac", "wav", "png", "bmp", "tiff"].includes(o.format);
  const copying = o.quality === "copy";
  const stillFromTimed = f.group === "image" && timed;

  show(el.fQuality, !lossless);
  show(el.fHeight, f.group !== "audio" && !copying);
  show(el.fMute, f.group === "video" && !f.animated && state.kind === "video");
  show(el.fStart, timed);
  show(el.fEnd, timed && !stillFromTimed);
  el.fStart.firstElementChild.textContent = stillFromTimed ? "Frame at" : "Trim start";

  for (const input of [el.start, el.end]) {
    const bad = input.value.trim() !== "" && parseTime(input.value) == null;
    input.classList.toggle("invalid", bad);
  }

  const args = buildArgs(inputName(), outputName(), visibleOptions());
  el.cmd.textContent = "ffmpeg " + args.map((a) => (/[\s'";\[\]]/.test(a) ? `"${a}"` : a)).join(" ");
}

/** Options with hidden controls neutralised, so stale values never leak into the command. */
function visibleOptions() {
  const o = currentOptions();
  if (el.fHeight.hidden) o.height = "";
  if (el.fMute.hidden) o.mute = false;
  if (el.fStart.hidden) o.start = "";
  if (el.fEnd.hidden) o.end = "";
  if (el.fQuality.hidden) o.quality = "balanced";
  o.inputArgs = state.input?.args;
  o.threads = threads;
  return o;
}

/* ------------------------------------------------------------------ */
/* File selection + probing                                            */
/* ------------------------------------------------------------------ */

function describeFile() {
  const parts = [fmtBytes(state.file.size)];
  const info = state.info;
  if (info) {
    if (info.duration && state.kind !== "image") parts.push(fmtDuration(info.duration));
    if (info.video) parts.push([info.video.codec, info.video.size].filter(Boolean).join(" "));
    if (info.audio) parts.push(info.audio.codec);
  }
  el.fmeta.textContent = parts.join(" · ");
}

async function selectFile(file) {
  if (state.busy) return;
  const token = ++state.token;
  state.file = file;
  state.ext = extensionOf(file.name);
  state.kind = guessKind(file);
  state.info = null;
  state.input = { blob: file, name: `input${state.ext ? "." + state.ext : ""}`, args: [] };
  state.heif = false;

  clearResult();
  setError("");
  logLines = [];
  renderLog();

  el.fname.textContent = file.name;
  describeFile();
  el.start.value = el.end.value = "";
  el.mute.checked = false;
  el.height.value = "";
  el.quality.value = "balanced";
  fillFormats();
  fillQuality();
  refreshOptions();

  el.drop.classList.add("compact");
  show(el.work, true);

  if (file.size > SOFT_SIZE_LIMIT) {
    setError("This file is larger than 2 GB. Browsers limit WebAssembly memory, so the conversion may fail.");
  }

  // Load the engine and read stream info up front so "Convert" is instant.
  let heifFailed = false;
  el.go.disabled = true;
  setStatus("Loading FFmpeg engine (≈32 MB, cached after first use)…");
  try {
    state.heif = await isHeif(file);
    if (token !== state.token) return;
    if (state.heif) {
      state.kind = "image";
      fillFormats();
      fillQuality();
      refreshOptions();
    }
    await ensureLoaded();
    if (token !== state.token) return;
    setStatus(state.heif ? "Decoding HEIC image…" : "Reading file…");
    if (state.heif) {
      let image;
      try {
        image = await decodeHeif(file);
      } catch (err) {
        if (token !== state.token) return;
        console.error(err);
        heifFailed = true;
        setError(`Could not decode this HEIC/HEIF image: ${err.message}`);
        return;
      }
      if (token !== state.token) return;
      state.input = {
        blob: new Blob([image.pixels]),
        name: "input.rgba",
        args: ["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${image.width}x${image.height}`],
      };
      state.info = { duration: null, video: { codec: "HEIC", size: `${image.width}×${image.height}` }, audio: null };
    } else {
      logLines = [];
      await run(state.input, ["-hide_banner", "-i", `${IN_DIR}/${inputName()}`]);
      if (token !== state.token) return;
      state.info = parseProbe(logLines);
    }
    if (!state.info.video && !state.info.audio) {
      setError("FFmpeg could not recognise this file as media. You can still try converting it.");
    } else if (!state.kind) {
      state.kind = state.info.video ? "video" : "audio";
      fillFormats();
      fillQuality();
    }
    describeFile();
    refreshOptions();
    logLines = [];
  } catch (err) {
    if (token !== state.token) return;
    console.error(err);
    killEngine();
    setError("Could not start the FFmpeg engine. Check your connection and that this browser supports WebAssembly, then try again.");
  } finally {
    if (token === state.token) {
      setStatus(null);
      el.go.disabled = heifFailed;
    }
  }
}

function resetToPicker() {
  if (state.busy) return;
  state.token++;
  state.file = null;
  clearResult();
  setError("");
  setStatus(null);
  el.file.value = "";
  show(el.work, false);
  el.drop.classList.remove("compact");
}

/* ------------------------------------------------------------------ */
/* Conversion                                                          */
/* ------------------------------------------------------------------ */

async function convert() {
  if (state.busy || !state.file) return;
  const opts = visibleOptions();
  const startS = opts.start ? parseTime(opts.start) : 0;
  const endS = opts.end ? parseTime(opts.end) : null;
  if (startS == null || (opts.end && endS == null)) {
    return setError("Trim times must look like 90, 1:30 or 0:01:30.");
  }
  if (endS != null && endS <= startS) return setError("Trim end must be after trim start.");

  const input = state.input;
  const format = FORMATS[opts.format];
  const outName = outputName();
  const args = buildArgs(`${IN_DIR}/${inputName()}`, outName, opts);

  // Expected output duration, for the progress bar.
  const full = state.info?.duration ?? null;
  let total = null;
  if (format.group !== "image") {
    const stop = endS != null ? (full != null ? Math.min(endS, full) : endS) : full;
    if (stop != null) total = Math.max(0.01, stop - startS);
  }

  state.busy = true;
  let cancelled = false;
  el.cancel.onclick = () => { cancelled = true; killEngine(); };
  clearResult();
  setError("");
  logLines = [];
  renderLog();
  el.go.disabled = true;
  show(el.cancel, true);
  setStatus("Converting…", total ? 0 : null);

  const started = performance.now();
  onLogLine = (line) => {
    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (m && total) setStatus("Converting…", clockToSeconds(m[1], m[2], m[3]) / total);
  };

  try {
    const code = await run(input, args);
    if (code !== 0) throw new Error(`FFmpeg exited with code ${code}`);
    const data = await ffmpeg.readFile(outName);
    await ffmpeg.deleteFile(outName).catch(() => {});
    if (!data.length) throw new Error("FFmpeg produced an empty file");
    showResult(new Blob([data], { type: format.mime }), opts.format, (performance.now() - started) / 1000);
  } catch (err) {
    if (cancelled) {
      setError("Conversion cancelled.");
    } else {
      console.error(err);
      const hint = [...logLines].reverse().find((l) => /error|invalid|unable|not found|unknown|could not|no such/i.test(l));
      const reason = (hint ?? err?.message ?? "").trim().replace(/[.:]$/, "");
      setError(`Conversion failed${reason ? ": " + reason : ""}. See the FFmpeg log below for details.`);
      // A crashed wasm instance (e.g. out of memory) is not reusable.
      if (!(err instanceof Error) || /memory|abort|unreachable/i.test(String(err?.message))) killEngine();
      else if (ffmpeg?.loaded) await ffmpeg.deleteFile(outName).catch(() => {});
    }
  } finally {
    onLogLine = null;
    state.busy = false;
    el.go.disabled = false;
    show(el.cancel, false);
    setStatus(null);
    renderLog();
  }
}

function showResult(blob, formatKey, seconds) {
  const format = FORMATS[formatKey];
  const base = state.file.name.replace(/\.[^.]+$/, "") || "converted";
  const name = `${base}.${extFor(formatKey)}`;
  state.resultUrl = URL.createObjectURL(blob);

  el.rname.textContent = name;
  const ratio = state.file.size ? Math.round((blob.size / state.file.size) * 100) : null;
  el.rmeta.textContent = [
    fmtBytes(blob.size),
    ratio != null ? `${ratio}% of original` : null,
    `done in ${seconds < 60 ? seconds.toFixed(1) + " s" : fmtDuration(seconds)}`,
  ].filter(Boolean).join(" · ");
  el.download.href = state.resultUrl;
  el.download.download = name;

  let node = null;
  if (format.group === "image" || format.animated) {
    if (formatKey !== "tiff") { node = new Image(); node.alt = "Converted image preview"; }
  } else {
    node = document.createElement(format.group === "audio" ? "audio" : "video");
    node.controls = true;
    node.preload = "metadata";
    if (!node.canPlayType(format.mime)) node = null;
  }
  if (node) {
    node.src = state.resultUrl;
    node.onerror = () => node.remove(); // browser can't preview this format; download still works
    el.preview.replaceChildren(node);
  }
  show(el.result, true);
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

showEngine();

el.file.addEventListener("change", () => {
  if (el.file.files[0]) selectFile(el.file.files[0]);
});

for (const type of ["dragenter", "dragover"]) {
  window.addEventListener(type, (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    el.drop.classList.add("over");
  });
}
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) el.drop.classList.remove("over");
});
window.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  el.drop.classList.remove("over");
  selectFile(e.dataTransfer.files[0]);
});

el.change.addEventListener("click", resetToPicker);
el.format.addEventListener("change", () => { fillQuality(); refreshOptions(); });
el.opts.addEventListener("input", refreshOptions);
el.opts.addEventListener("submit", (e) => { e.preventDefault(); convert(); });
