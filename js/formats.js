// Output format catalogue and FFmpeg argument builder.
// Every encoder referenced here is compiled into the vendored @ffmpeg/core build.

const Q = { high: 0, balanced: 1, small: 2 };
const pick = (quality, values) => values[Q[quality] ?? 1];

const h264 = (q) => ["-c:v", "libx264", "-preset", "veryfast", "-crf", pick(q, ["19", "24", "30"]), "-pix_fmt", "yuv420p"];
const aac = (q) => ["-c:a", "aac", "-b:a", pick(q, ["192k", "128k", "96k"])];

export const FORMATS = {
  // ---- video ----
  mp4: {
    group: "video", label: "MP4 (H.264 + AAC)", mime: "video/mp4", remux: true,
    video: h264, audio: aac, extra: ["-movflags", "+faststart"],
  },
  webm: {
    group: "video", label: "WebM (VP8 + Vorbis)", mime: "video/webm",
    video: (q) => ["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "4",
      "-crf", pick(q, ["8", "16", "30"]), "-b:v", pick(q, ["4M", "2M", "800k"]), "-pix_fmt", "yuv420p"],
    audio: (q) => ["-c:a", "libvorbis", "-q:a", pick(q, ["6", "4", "2"])],
  },
  mkv: {
    group: "video", label: "MKV (H.264 + AAC)", mime: "video/x-matroska", remux: true,
    video: h264, audio: aac,
  },
  mov: {
    group: "video", label: "MOV (H.264 + AAC)", mime: "video/quicktime", remux: true,
    video: h264, audio: aac, extra: ["-movflags", "+faststart"],
  },
  avi: {
    group: "video", label: "AVI (MPEG-4 + MP3)", mime: "video/x-msvideo",
    video: (q) => ["-c:v", "mpeg4", "-q:v", pick(q, ["3", "6", "10"])],
    audio: (q) => ["-c:a", "libmp3lame", "-b:a", pick(q, ["192k", "128k", "96k"])],
  },
  gif: {
    group: "video", label: "GIF (animated)", mime: "image/gif", animated: true,
  },

  // ---- audio ----
  mp3: {
    group: "audio", label: "MP3", mime: "audio/mpeg",
    audio: (q) => ["-c:a", "libmp3lame", "-b:a", pick(q, ["320k", "192k", "128k"])],
  },
  m4a: {
    group: "audio", label: "M4A (AAC)", mime: "audio/mp4",
    audio: (q) => ["-c:a", "aac", "-b:a", pick(q, ["256k", "160k", "96k"])],
  },
  ogg: {
    group: "audio", label: "OGG (Vorbis)", mime: "audio/ogg",
    audio: (q) => ["-c:a", "libvorbis", "-q:a", pick(q, ["8", "5", "2"])],
  },
  opus: {
    group: "audio", label: "Opus", mime: "audio/ogg",
    audio: (q) => ["-c:a", "libopus", "-b:a", pick(q, ["192k", "112k", "64k"])],
  },
  flac: { group: "audio", label: "FLAC (lossless)", mime: "audio/flac", audio: () => ["-c:a", "flac"] },
  wav: { group: "audio", label: "WAV (lossless)", mime: "audio/wav", audio: () => ["-c:a", "pcm_s16le"] },

  // ---- image ----
  png: { group: "image", label: "PNG", mime: "image/png", image: () => [] },
  jpg: {
    group: "image", label: "JPEG", mime: "image/jpeg",
    image: (q) => ["-q:v", pick(q, ["2", "5", "12"]), "-pix_fmt", "yuvj420p"],
  },
  webp: {
    group: "image", label: "WebP", mime: "image/webp",
    image: (q) => ["-c:v", "libwebp", "-quality", pick(q, ["92", "78", "50"])],
  },
  bmp: { group: "image", label: "BMP", mime: "image/bmp", image: () => [] },
  tiff: { group: "image", label: "TIFF", mime: "image/tiff", image: () => ["-compression_algo", "deflate"] },
};

export const GROUP_LABELS = { video: "Video", audio: "Audio", image: "Image" };

const EXT_KIND = {
  video: "mp4 m4v mov mkv webm avi wmv flv mpg mpeg ts mts m2ts 3gp ogv vob",
  audio: "mp3 wav flac ogg oga opus m4a aac wma aiff aif amr ac3 mka",
  image: "png jpg jpeg webp bmp tif tiff gif ico tga",
};

/** Guess "video" | "audio" | "image" | null from a File's MIME type and extension. */
export function guessKind(file) {
  const ext = extensionOf(file.name);
  for (const [kind, list] of Object.entries(EXT_KIND)) {
    if (list.split(" ").includes(ext)) return kind;
  }
  const major = (file.type || "").split("/")[0];
  return ["video", "audio", "image"].includes(major) ? major : null;
}

export function extensionOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/** Which output formats make sense for a given input. */
export function targetsFor(kind, ext) {
  const all = Object.keys(FORMATS);
  const of = (group) => all.filter((k) => FORMATS[k].group === group);
  const stills = of("image");
  switch (kind) {
    case "video": return [...of("video"), ...of("audio"), ...stills];
    case "audio": return of("audio");
    case "image": return ext === "gif" ? [...stills, ...of("video").filter((k) => k !== "gif")] : stills;
    default: return all;
  }
}

/** Split a user-typed argument string, honouring single and double quotes. */
export function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Build the FFmpeg argument list.
 * opts: { format, quality, height, mute, start, end, extra }
 */
export function buildArgs(input, output, opts) {
  const f = FORMATS[opts.format];
  const q = opts.quality;
  const args = ["-hide_banner"];
  if (opts.start) args.push("-ss", opts.start);
  if (opts.end) args.push("-to", opts.end);
  args.push("-i", input);

  const h = Number(opts.height) || 0;

  if (f.group === "image") {
    if (h) args.push("-vf", `scale=-1:'min(${h},ih)':flags=lanczos`);
    args.push("-frames:v", "1", "-update", "1", "-an", ...f.image(q));
  } else if (f.animated) {
    const fps = pick(q, [20, 12, 8]);
    const scale = h ? `,scale=-1:'min(${h},ih)':flags=lanczos` : "";
    args.push(
      "-filter_complex",
      `[0:v]fps=${fps}${scale},split[a][b];[a]palettegen[p];[b][p]paletteuse`,
      "-an", "-loop", "0",
    );
  } else if (f.group === "audio") {
    args.push("-vn", ...f.audio(q));
  } else if (q === "copy" && f.remux) {
    args.push("-c", "copy");
    if (opts.mute) args.push("-an");
    if (f.extra) args.push(...f.extra);
  } else {
    // Encoders using 4:2:0 chroma need even dimensions.
    const scale = h
      ? `scale=-2:'trunc(min(${h},ih)/2)*2'`
      : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
    args.push("-vf", scale, ...f.video(q));
    if (opts.mute) args.push("-an");
    else args.push(...f.audio(q));
    if (f.extra) args.push(...f.extra);
  }

  if (opts.extra) args.push(...splitArgs(opts.extra));
  args.push(output);
  return args;
}
