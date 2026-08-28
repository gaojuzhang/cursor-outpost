import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { slugFromRepoUrl } from "./core/repo-url.js";

const CONFIG_DIR_NAME = "cursor-outpost";
const CURSOR_API_BASE = "https://api.cursor.com/v1";

export type ProjectConfig = {
  slug: string;
  repo_url: string;
  ref: string;
  default?: boolean;
};

export type AppConfig = {
  cursorApiKey: string;
  telegramBotToken: string | undefined;
  telegramAllowUserIds: string[];
  projects: ProjectConfig[];
  telegram: { verbose: boolean };
  poller: { interval_ms: number };
  agent_catalog: { interval_ms: number };
  repo_catalog: { interval_ms: number };
  paths: {
    configDir: string;
    configYaml: string;
    envFile: string;
    stateDb: string;
  };
  apiBase: string;
};

/** Mask secrets for logs — never print the full key. */
export function redactSecret(value: string): string {
  if (!value) return "(empty)";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadDotEnv(envPath: string): void {
  if (!existsSync(envPath)) return;
  const parsed = parseEnvFile(readFileSync(envPath, "utf8"));
  for (const [key, val] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

type YamlRoot = {
  projects?: Array<{
    slug?: string;
    repo_url?: string;
    ref?: string;
    default?: boolean;
  }>;
  telegram?: { verbose?: boolean };
  poller?: { interval_ms?: number };
  agent_catalog?: { interval_ms?: number };
  repo_catalog?: { interval_ms?: number };
};

export function loadConfig(configDir = join(homedir(), ".config", CONFIG_DIR_NAME)): AppConfig {
  const paths = {
    configDir,
    configYaml: join(configDir, "config.yaml"),
    envFile: join(configDir, ".env"),
    stateDb: join(configDir, "state.db"),
  };

  loadDotEnv(paths.envFile);

  const cursorApiKey = process.env.CURSOR_API_KEY?.trim() ?? "";
  if (!cursorApiKey) {
    throw new Error(
      `Missing CURSOR_API_KEY. Set it in ${paths.envFile} or the environment.`,
    );
  }

  if (!existsSync(paths.configYaml)) {
    throw new Error(
      `Missing ${paths.configYaml}. Copy config.example.yaml from the repo.`,
    );
  }

  const raw = parseYaml(readFileSync(paths.configYaml, "utf8")) as YamlRoot | null;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid YAML in ${paths.configYaml}`);
  }

  const projects: ProjectConfig[] = (raw.projects ?? []).map((p, i) => {
    if (!p?.repo_url || !p?.ref) {
      throw new Error(
        `projects[${i}] must have repo_url and ref in ${paths.configYaml}`,
      );
    }
    const slug =
      p.slug?.trim() || slugFromRepoUrl(p.repo_url);
    return {
      slug,
      repo_url: p.repo_url,
      ref: p.ref,
      default: Boolean(p.default),
    };
  });

  const defaults = projects.filter((p) => p.default);
  if (defaults.length > 1) {
    throw new Error(`Only one project may have default: true in ${paths.configYaml}`);
  }

  const allowRaw = process.env.TELEGRAM_ALLOW_USER_IDS ?? "";
  const telegramAllowUserIds = allowRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    cursorApiKey,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramAllowUserIds,
    projects,
    telegram: { verbose: Boolean(raw.telegram?.verbose) },
    poller: {
      interval_ms:
        typeof raw.poller?.interval_ms === "number" && raw.poller.interval_ms > 0
          ? raw.poller.interval_ms
          : 8000,
    },
    agent_catalog: {
      interval_ms:
        typeof raw.agent_catalog?.interval_ms === "number" &&
        raw.agent_catalog.interval_ms > 0
          ? raw.agent_catalog.interval_ms
          : 300_000,
    },
    repo_catalog: {
      interval_ms:
        typeof raw.repo_catalog?.interval_ms === "number" &&
        raw.repo_catalog.interval_ms > 0
          ? raw.repo_catalog.interval_ms
          : 180_000,
    },
    paths,
    apiBase: CURSOR_API_BASE,
  };
}
