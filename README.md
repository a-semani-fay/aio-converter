# aio-converter

An all-in-one media conversion tool that runs entirely in the browser. Pick a
video, audio or image file, choose an output format, and download the result.
Files are processed locally by [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)
(FFmpeg compiled to WebAssembly) in a web worker — nothing is uploaded.

## Features

- **Video:** MP4 (H.264 or H.265/HEVC), WebM, MKV, MOV, AVI, animated GIF
- **Audio:** MP3, M4A, OGG, Opus, FLAC, WAV (also extracts audio from video)
- **Image:** PNG, JPEG, WebP, BMP, TIFF (also grabs a frame from video)
- **HEIC/HEIF input:** decoded with libheif, then converted to any image format
- Multi-threaded encoding where the browser allows it
- Quality presets, downscaling, trimming, removing audio
- "Copy streams" mode to change container without re-encoding
- Extra FFmpeg arguments and a live preview of the command being run
- Progress bar, cancel, output preview and full FFmpeg log

## Running

It is a plain static site with no build step. Serve the repository root with
any static file server:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` straight from disk
(`file://`) does not work, because browsers block module workers and
WebAssembly loading there.

## Hosting

Any static host works (GitHub Pages, Netlify, Cloudflare Pages, S3, …). No
special headers are required.

Multi-threaded FFmpeg needs `SharedArrayBuffer`, which browsers only expose on
cross-origin isolated pages (COOP/COEP headers). Static hosts such as GitHub
Pages cannot send those headers, so `coi-serviceworker.js` registers a service
worker that adds them to every response and reloads the page once on the first
visit. It must stay in the same directory as `index.html`, and the site must be
served over HTTPS (or `localhost`).

If isolation is unavailable (service workers blocked, some private-browsing
modes), the app falls back to the single-threaded core. Everything still works
except H.265/HEVC output, whose encoder hangs without threads. The page footer
shows which engine is active.

For GitHub Pages: Settings → Pages → Deploy from a branch → `/ (root)`.

## Limits

- WebAssembly FFmpeg is several times slower than native FFmpeg, even with
  threads. Long or high-resolution videos take a while, H.265 especially.
- HEIC/HEIF is input only, and only the primary image of a file is converted.
  AVIF is not supported.
- WebAssembly memory is capped (2 GB at most), and the output is held in
  memory, so very large files can fail. The input is read directly from disk
  and is not copied into memory.
- The engine is a ~32 MB download on first use; the browser caches it after.
  Only one of the two cores is downloaded.

## Layout

```
index.html        page
css/style.css     styles (light and dark)
js/app.js         UI, engine lifecycle, progress
js/formats.js     output formats and FFmpeg argument builder
js/heic-worker.js HEIC/HEIF decoding worker
coi-serviceworker.js  cross-origin isolation shim (coi-serviceworker 0.1.7, MIT)
vendor/ffmpeg/    @ffmpeg/ffmpeg 0.12.15 (ESM build, MIT)
vendor/core/      @ffmpeg/core 0.12.10 (single-threaded, GPL-2.0-or-later)
vendor/core-mt/   @ffmpeg/core-mt 0.12.10 (multi-threaded, GPL-2.0-or-later)
vendor/libheif/   libheif-js 1.23.5 wasm bundle (LGPL-3.0)
```

## Licences

The vendored `@ffmpeg/core` and `@ffmpeg/core-mt` binaries bundle FFmpeg with x264, x265 and other
libraries and are distributed under GPL-2.0-or-later; their source is at
<https://github.com/ffmpegwasm/ffmpeg.wasm>. `@ffmpeg/ffmpeg` and
`coi-serviceworker` are MIT. libheif is LGPL-3.0 (see `vendor/libheif/LICENSE`;
source at <https://github.com/strukturag/libheif>).
