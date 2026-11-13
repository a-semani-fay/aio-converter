// Decodes a HEIC/HEIF still image to raw RGBA pixels with libheif (WebAssembly).
// The FFmpeg 5.1 build used by ffmpeg.wasm cannot read HEIF containers itself.
import createLibheif from "../vendor/libheif/libheif-bundle.mjs";

let libheif = null;

self.onmessage = async ({ data: file }) => {
  try {
    libheif ??= createLibheif();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const images = new libheif.HeifDecoder().decode(bytes);
    if (!images?.length) throw new Error("No image found in this HEIF file");
    const image = images[0]; // primary image; orientation is already applied
    const width = image.get_width();
    const height = image.get_height();
    const pixels = await new Promise((resolve, reject) => {
      image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (out) =>
        out ? resolve(out.data) : reject(new Error("HEIF decoding failed")));
    });
    self.postMessage({ width, height, pixels: pixels.buffer }, [pixels.buffer]);
  } catch (err) {
    self.postMessage({ error: String(err?.message ?? err) });
  }
};
