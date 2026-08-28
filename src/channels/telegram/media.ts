import type { Api } from "grammy";
import type { IncomingImage } from "../types.js";

/** MIME types accepted by Cursor Cloud Agents API. */
export const CURSOR_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const DOWNLOAD_RETRY_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function normalizeImageMime(mime?: string): string | undefined {
  if (!mime) return undefined;
  const m = mime.toLowerCase().split(";")[0].trim();
  if (m === "image/jpg") return "image/jpeg";
  return CURSOR_IMAGE_MIMES.has(m) ? m : undefined;
}

export function mimeFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return undefined;
}

/** Basic magic-byte check so we do not send corrupt blobs to Cursor. */
export function isValidRasterBytes(buf: Buffer, mimeType: string): boolean {
  if (buf.length < 12) return false;
  switch (mimeType) {
    case "image/jpeg":
      return buf[0] === 0xff && buf[1] === 0xd8;
    case "image/png":
      return (
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47
      );
    case "image/gif":
      return buf.subarray(0, 3).toString("ascii") === "GIF";
    case "image/webp":
      return (
        buf.subarray(0, 4).toString("ascii") === "RIFF" &&
        buf.subarray(8, 12).toString("ascii") === "WEBP"
      );
    default:
      return false;
  }
}

async function fetchWithRetry(url: string): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < DOWNLOAD_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fetch(url);
    } catch (err) {
      last = err;
      if (attempt + 1 < DOWNLOAD_RETRY_ATTEMPTS) {
        await sleep(DOWNLOAD_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * Download a Telegram file and encode for Cursor prompt.images.
 */
export async function downloadTelegramFileAsImage(
  api: Api,
  botToken: string,
  fileId: string,
  mimeHint?: string,
  dimension?: { width: number; height: number },
): Promise<IncomingImage | undefined> {
  const file = await api.getFile(fileId);
  if (!file.file_path) return undefined;

  const mimeType =
    normalizeImageMime(mimeHint) ?? mimeFromPath(file.file_path) ?? "image/jpeg";

  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return undefined;

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || !isValidRasterBytes(buf, mimeType)) return undefined;

  const image: IncomingImage = {
    data: buf.toString("base64"),
    mimeType,
  };
  if (dimension && dimension.width > 0 && dimension.height > 0) {
    image.dimension = {
      width: dimension.width,
      height: dimension.height,
    };
  }
  return image;
}
