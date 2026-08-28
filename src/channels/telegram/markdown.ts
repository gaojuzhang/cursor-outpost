import { escapeTelegramHtml } from "./format.js";

/** Agent markdown → Telegram HTML (no full GFM; tables → &lt;pre&gt;). */
export function markdownToTelegramHtml(input: string): string {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceLines: string[] = [];
  let tableLines: string[] = [];

  const flushFence = (): void => {
    if (fenceLines.length === 0) return;
    out.push(`<pre>${escapeTelegramHtml(fenceLines.join("\n"))}</pre>`);
    fenceLines = [];
  };

  const flushTable = (): void => {
    if (tableLines.length === 0) return;
    out.push(`<pre>${escapeTelegramHtml(tableLines.join("\n"))}</pre>`);
    tableLines = [];
  };

  const isTableRow = (line: string): boolean => {
    const t = line.trim();
    if (!t.includes("|")) return false;
    return /^\|?.+\|.+\|?$/.test(t);
  };

  const isTableSep = (line: string): boolean =>
    /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line.trim());

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flushTable();
      if (inFence) {
        flushFence();
        inFence = false;
      } else {
        inFence = true;
      }
      continue;
    }

    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    if (isTableRow(line) || isTableSep(line)) {
      tableLines.push(line);
      continue;
    }

    flushTable();

    if (!trimmed) {
      out.push("");
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      out.push(`<b>${formatInlineMarkdown(heading[2]!)}</b>`);
      continue;
    }

    out.push(formatInlineMarkdown(line));
  }

  flushTable();
  if (inFence) flushFence();

  return out.join("\n");
}

function formatInlineMarkdown(text: string): string {
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`")) {
        return `<code>${escapeTelegramHtml(part.slice(1, -1))}</code>`;
      }
      return formatInlineNoCode(part);
    })
    .join("");
}

function formatInlineNoCode(text: string): string {
  const tokens: string[] = [];
  let s = text;

  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label: string, url: string) => {
      const i = tokens.length;
      tokens.push(
        `<a href="${escapeTelegramHtml(url)}">${escapeTelegramHtml(label)}</a>`,
      );
      return `\x00T${i}\x00`;
    },
  );

  s = s.replace(/\*\*([^*]+)\*\*/g, (_, inner: string) => {
    const i = tokens.length;
    tokens.push(`<b>${escapeTelegramHtml(inner)}</b>`);
    return `\x00T${i}\x00`;
  });

  s = s.replace(/__([^_]+)__/g, (_, inner: string) => {
    const i = tokens.length;
    tokens.push(`<b>${escapeTelegramHtml(inner)}</b>`);
    return `\x00T${i}\x00`;
  });

  s = escapeTelegramHtml(s);
  return s.replace(/\x00T(\d+)\x00/g, (_, i: string) => tokens[Number(i)] ?? "");
}
