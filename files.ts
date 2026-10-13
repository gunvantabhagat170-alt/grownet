import { MAX_DATA_URL_CHARS } from "./constants";

export async function readUpload(file: File): Promise<string> {
  if (file.size > 8_000_000) {
    throw new Error("File is too large. Compress it or paste a URL instead.");
  }
  if (file.type.startsWith("image/")) {
    return resizeImage(file, 1400);
  }
  const raw = await readAsDataUrl(file);
  if (raw.length > MAX_DATA_URL_CHARS) {
    throw new Error("File is too large for in-app storage. Use a URL instead.");
  }
  return raw;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

async function resizeImage(file: File, maxEdge: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not process image");
    ctx.drawImage(img, 0, 0, w, h);
    const out = canvas.toDataURL("image/jpeg", 0.82);
    if (out.length > MAX_DATA_URL_CHARS) {
      throw new Error("Image is still too large. Use a URL instead.");
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}
