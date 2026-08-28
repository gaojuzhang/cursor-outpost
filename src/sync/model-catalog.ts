import type { SDKModel } from "@cursor/sdk";
import { AUTO_MODEL_ID, isAutoModelId, normalizeModelToken } from "../core/model-prefs.js";
import type { CursorClient } from "../cursor/client.js";

export type ModelCatalogDeps = {
  cursor: CursorClient;
  intervalMs?: number;
};

export class ModelCatalog {
  private readonly cursor: CursorClient;
  private readonly intervalMs: number;
  private models: SDKModel[] | null = null;
  private loadedAt = 0;

  constructor(deps: ModelCatalogDeps) {
    this.cursor = deps.cursor;
    this.intervalMs = deps.intervalMs ?? 300_000;
  }

  async list(force = false): Promise<SDKModel[]> {
    if (
      !force &&
      this.models &&
      Date.now() - this.loadedAt < this.intervalMs
    ) {
      return this.models;
    }
    this.models = await this.cursor.listModels();
    this.loadedAt = Date.now();
    return this.models;
  }

  displayName(id: string | null | undefined, models?: SDKModel[]): string {
    if (isAutoModelId(id)) return "Auto";
    const needle = id!.trim();
    const list = models ?? this.models ?? [];
    const hit = list.find(
      (m) =>
        m.id === needle ||
        m.aliases?.some((a) => a.toLowerCase() === needle.toLowerCase()),
    );
    return hit?.displayName ?? needle;
  }

  formatIdLabel(id: string | null | undefined, models?: SDKModel[]): string {
    if (isAutoModelId(id)) return "Auto (default)";
    const name = this.displayName(id, models);
    return name === id ? id! : `${name} (${id})`;
  }

  /**
   * Resolve `/model <token>`: auto, numeric index, id, or alias.
   */
  resolveToken(
    token: string,
    models: SDKModel[],
    pickerLimit = 15,
  ): SDKModel | "auto" | undefined {
    const raw = token.trim();
    if (!raw) return undefined;
    const norm = normalizeModelToken(raw);
    if (norm === AUTO_MODEL_ID) return "auto";

    if (/^\d+$/.test(raw)) {
      const idx = Number.parseInt(raw, 10);
      const picker = this.pickerModels(models, pickerLimit);
      if (idx < 1 || idx > picker.length) return undefined;
      return picker[idx - 1];
    }

    const lower = raw.toLowerCase();
    const exact = models.find(
      (m) =>
        m.id.toLowerCase() === lower ||
        m.aliases?.some((a) => a.toLowerCase() === lower),
    );
    if (exact) return exact;

    const prefix = models.filter((m) => m.id.toLowerCase().startsWith(lower));
    if (prefix.length === 1) return prefix[0];
    return undefined;
  }

  /** Curated list for Telegram (Auto first, then common models). */
  pickerModels(models: SDKModel[], limit = 15): SDKModel[] {
    const auto = models.find((m) => m.id === AUTO_MODEL_ID);
    const rest = models.filter((m) => m.id !== AUTO_MODEL_ID);
    const out: SDKModel[] = [];
    if (auto) out.push(auto);
    for (const m of rest) {
      if (out.length >= limit) break;
      out.push(m);
    }
    return out;
  }
}
