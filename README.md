# aio-converter

An all-in-one media conversion tool that runs entirely in the browser. Pick a
video, audio or image file, choose an output format, and download the result.
Files are processed locally by [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)
(FFmpeg compiled to WebAssembly) in a web worker — nothing is uploaded.

## Features

- **Video:** MP4, WebM, MKV, MOV, AVI, animated GIF
- **Audio:** MP3, M4A, OGG, Opus, FLAC, WAV (also extracts audio from video)
- **Image:** PNG, JPEG, WebP, BMP, TIFF (also grabs a frame from video)
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
special headers are required: the app uses the single-threaded FFmpeg core, so
it does not need `SharedArrayBuffer` or cross-origin isolation (COOP/COEP).

For GitHub Pages: Settings → Pages → Deploy from a branch → `/ (root)`.

## Limits

- The single-threaded WebAssembly build is several times slower than native
  FFmpeg. Long or high-resolution videos take a while.
- WebAssembly memory is capped (2 GB at most), and the output is held in
  memory, so very large files can fail. The input is read directly from disk
  and is not copied into memory.
- The engine is a ~32 MB download on first use; the browser caches it after.

## Layout

```
index.html        page
css/style.css     styles (light and dark)
js/app.js         UI, engine lifecycle, progress
js/formats.js     output formats and FFmpeg argument builder
vendor/ffmpeg/    @ffmpeg/ffmpeg 0.12.15 (ESM build, MIT)
vendor/core/      @ffmpeg/core 0.12.10 (FFmpeg + codecs, GPL-2.0-or-later)
```

## Licences

The vendored `@ffmpeg/core` binary bundles FFmpeg with x264, x265 and other
libraries and is distributed under GPL-2.0-or-later; its source is at
<https://github.com/ffmpegwasm/ffmpeg.wasm>. `@ffmpeg/ffmpeg` is MIT.
