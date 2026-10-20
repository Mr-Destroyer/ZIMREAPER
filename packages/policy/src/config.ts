import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ZimReaperError } from "@zimreaper/protocol";
import type { OriginPolicy, PolicyConfig } from "./types.js";

const OriginPolicyFileSchema = z
  .object({
    tier: z.enum(["read", "interact", "transact"]).optional(),
    allowEval: z.boolean().optional(),
    allowUploads: z.boolean().optional(),
    allowDownloads: z.boolean().optional(),
  })
  .strict();

const PolicyConfigFileSchema = z
  .object({
    mode: z.enum(["permissive", "standard", "strict"]).optional(),
    origins: z.record(OriginPolicyFileSchema).optional(),
    destructivePatterns: z.array(z.string().min(1)).optional(),
    approvalTimeoutMs: z.number().int().positive().optional(),
    maxActionsPerMinute: z.number().int().positive().optional(),
  })
  .strict();

type PolicyConfigFile = z.infer<typeof PolicyConfigFileSchema>;

export function defaultPolicyConfig(): PolicyConfig {
  return {
    mode: "standard",
    origins: {},
    destructivePatterns: [
      "pay",
      "purchase",
      "buy now",
      "place order",
      "send",
      "delete",
      "remove",
      "publish",
      "post",
      "transfer",
      "authorize",
      "grant access",
    ],
    approvalTimeoutMs: 120_000,
    maxActionsPerMinute: 240,
  };
}

export function clonePolicyConfig(config: PolicyConfig): PolicyConfig {
  const origins: Record<string, OriginPolicy> = {};
  for (const [key, value] of Object.entries(config.origins)) {
    origins[key] = { ...value };
  }
  return {
    mode: config.mode,
    origins,
    destructivePatterns: [...config.destructivePatterns],
    approvalTimeoutMs: config.approvalTimeoutMs,
    maxActionsPerMinute: config.maxActionsPerMinute,
  };
}

export function mergePolicyConfig(base: PolicyConfig, patch?: Partial<PolicyConfig>): PolicyConfig {
  const merged = clonePolicyConfig(base);
  if (!patch) return merged;
  if (patch.mode !== undefined) merged.mode = patch.mode;
  if (patch.approvalTimeoutMs !== undefined) merged.approvalTimeoutMs = patch.approvalTimeoutMs;
  if (patch.maxActionsPerMinute !== undefined) merged.maxActionsPerMinute = patch.maxActionsPerMinute;
  if (patch.destructivePatterns !== undefined) merged.destructivePatterns = [...patch.destructivePatterns];
  for (const [key, value] of Object.entries(patch.origins ?? {})) {
    merged.origins[key] = { ...(merged.origins[key] ?? { tier: "read" }), ...value };
  }
  return merged;
}

function normalizeFileConfig(input: PolicyConfigFile): Partial<PolicyConfig> {
  const origins: Record<string, OriginPolicy> = {};
  for (const [key, value] of Object.entries(input.origins ?? {})) {
    origins[key] = { ...value, tier: value.tier ?? "read" };
  }
  return {
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.origins !== undefined ? { origins } : {}),
    ...(input.destructivePatterns !== undefined ? { destructivePatterns: input.destructivePatterns } : {}),
    ...(input.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: input.approvalTimeoutMs } : {}),
    ...(input.maxActionsPerMinute !== undefined ? { maxActionsPerMinute: input.maxActionsPerMinute } : {}),
  };
}

/**
 * Read `<dir>/policy.json` and deep-merge it over the defaults. On first run the
 * defaults are written back with mode 0600 so the file is never group/world
 * readable.
 */
export function loadPolicy(dir: string): PolicyConfig {
  const defaults = defaultPolicyConfig();
  const path = join(dir, "policy.json");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ZimReaperError("INTERNAL", `cannot create policy directory ${dir}`, {
      details: error instanceof Error ? error.message : String(error),
    });
  }

  if (!existsSync(path)) {
    try {
      writeFileSync(path, `${JSON.stringify(defaults, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      throw new ZimReaperError("INTERNAL", `cannot write ${path}`, {
        details: error instanceof Error ? error.message : String(error),
      });
    }
    return defaults;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ZimReaperError("BAD_REQUEST", `invalid policy.json at ${path}`, {
      details: error instanceof Error ? error.message : String(error),
    });
  }

  const parsed = PolicyConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ZimReaperError("BAD_REQUEST", `invalid policy.json at ${path}`, {
      details: parsed.error.issues,
    });
  }
  return mergePolicyConfig(defaults, normalizeFileConfig(parsed.data));
}
