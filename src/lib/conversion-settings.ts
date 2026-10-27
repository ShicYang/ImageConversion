import type { ConversionSettings } from "../types/conversion";

const STORAGE_KEY = "image-conversion.settings.v1";
const FORMATS = ["png", "jpeg", "webp", "bmp", "gif", "tiff", "ico"];
const MODES = ["none", "fit", "exact", "longest"];

export function defaultSettings(): ConversionSettings {
  return {
    targetFormat: "png",
    quality: 90,
    pngCompression: "balanced",
    webpMode: "lossless",
    jpegBackground: "#ffffff",
    resize: { mode: "none", width: null, height: null, longestEdge: 1920, allowUpscale: false },
    icoSize: 256,
  };
}

function dimension(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffffffff
    ? value : null;
}

export function loadSettings(): ConversionSettings {
  const defaults = defaultSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return defaults;
    const resize = saved.resize && typeof saved.resize === "object" ? saved.resize : {};
    return {
      targetFormat: FORMATS.includes(saved.targetFormat) ? saved.targetFormat : defaults.targetFormat,
      quality: Number.isInteger(saved.quality) && saved.quality >= 1 && saved.quality <= 100 ? saved.quality : defaults.quality,
      pngCompression: ["fast", "balanced", "best"].includes(saved.pngCompression) ? saved.pngCompression : defaults.pngCompression,
      webpMode: ["lossless", "lossy"].includes(saved.webpMode) ? saved.webpMode : defaults.webpMode,
      jpegBackground: typeof saved.jpegBackground === "string" && /^#[0-9a-f]{6}$/i.test(saved.jpegBackground)
        ? saved.jpegBackground : defaults.jpegBackground,
      icoSize: [16, 32, 48, 64, 128, 256].includes(saved.icoSize) ? saved.icoSize : defaults.icoSize,
      resize: {
        mode: MODES.includes(resize.mode) ? resize.mode : defaults.resize.mode,
        width: dimension(resize.width),
        height: dimension(resize.height),
        longestEdge: dimension(resize.longestEdge) ?? defaults.resize.longestEdge,
        allowUpscale: resize.allowUpscale === true,
      },
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings: ConversionSettings): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function settingsSummary(settings: ConversionSettings): string {
  const parts = [settings.targetFormat.toUpperCase()];
  if (settings.targetFormat === "jpeg") parts.push(`质量 ${settings.quality}`, `背景 ${settings.jpegBackground}`);
  if (settings.targetFormat === "png") parts.push(`无损 · ${{ fast: "快速压缩", balanced: "均衡压缩", best: "更小体积" }[settings.pngCompression]}`);
  if (settings.targetFormat === "webp") parts.push(settings.webpMode === "lossless" ? "无损" : `有损 · 质量 ${settings.quality}`);
  if (settings.targetFormat === "ico") return `ICO · ${settings.icoSize} × ${settings.icoSize} · 等比缩放，透明留白`;
  if (settings.resize.mode === "none") parts.push("保持原尺寸");
  if (settings.resize.mode === "longest") parts.push(`最长边 ${settings.resize.longestEdge ?? "未填写"} px`);
  if (settings.resize.mode === "fit") parts.push(`等比适配 ${settings.resize.width ?? "自动"} × ${settings.resize.height ?? "自动"}`);
  if (settings.resize.mode === "exact") parts.push(`拉伸 ${settings.resize.width ?? "未填写"} × ${settings.resize.height ?? "未填写"}`);
  if (settings.resize.mode !== "none") parts.push(settings.resize.allowUpscale ? "允许放大" : "不放大");
  return parts.join(" · ");
}
