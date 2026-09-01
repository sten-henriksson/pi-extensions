import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { extname, resolve } from "node:path";
import { artifactPath, isContained, loadWikiConfig, WikiConfigError } from "../scripts/wiki-config.mjs";

const SENSITIVE_PATTERNS = [
  /\b(?:password|passwd)\s*[:=]\s*\S+/i,
  /\bauthorization\s*:\s*bearer\s+\S+/i,
  /\b(?:cookie|set-cookie)\s*:\s*\S+/i,
  /\bsession(?:id|[-_ ]?token)?\s*[:=]\s*\S+/i,
  /\b(?:\.local|10\.65\.\d{1,3}\.\d{1,3})\b/i,
  /\b(?:raw[-_ ]?har|\.har\b)\b/i,
];

function hasSensitiveContent(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function selectedConfigPath(explicit?: string, env: NodeJS.ProcessEnv = process.env) {
  return explicit?.trim() || env.SPIDERVERSE_CONFIG_PATH || "wiki.yaml";
}

async function activeConfig(cwd: string, configPath?: string) {
  return loadWikiConfig(selectedConfigPath(configPath), cwd);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("spiderverse-config", {
    description: "Show the validated Spiderverse wiki.yaml artifact roots.",
    handler: async (args, ctx) => {
      try {
        const loaded = await activeConfig(ctx.cwd, args);
        ctx.ui.notify(`Spiderverse site: ${loaded.config.site.title}`, "info");
        ctx.ui.notify(`Markdown: ${loaded.roots.markdown_root}\nImages: ${loaded.roots.image_root}`, "info");
      } catch (error) {
        ctx.ui.notify(`Spiderverse config error: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "spiderverse_inspect_config",
    label: "Inspect Spiderverse Config",
    description: "Validate wiki.yaml and show the configured site and artifact locations without reading browser state or secrets.",
    promptSnippet: "Inspect a Spiderverse site configuration and its safe artifact roots",
    promptGuidelines: ["Use spiderverse_inspect_config before generating a website knowledge base or planning its artifacts."],
    parameters: Type.Object({
      configPath: Type.Optional(Type.String({ description: "Path to wiki.yaml relative to the project root" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const loaded = await activeConfig(ctx.cwd, params.configPath);
      return {
        content: [{ type: "text", text: JSON.stringify({
          site: loaded.config.site,
          authentication: loaded.config.authentication,
          artifacts: loaded.roots,
          safety: loaded.config.safety,
        }, null, 2) }],
        details: { configPath: loaded.configPath, roots: loaded.roots },
      };
    },
  });

  pi.registerTool({
    name: "spiderverse_plan_artifact",
    label: "Plan Spiderverse Artifact",
    description: "Resolve a Markdown, image, evidence, flow, or report artifact under the configured wiki.yaml root. This tool never creates files.",
    promptSnippet: "Plan a safe output path for a Spiderverse documentation artifact",
    promptGuidelines: ["Use spiderverse_plan_artifact before writing a generated artifact so its configured root and publication safety are verified."],
    parameters: Type.Object({
      kind: StringEnum(["markdown", "image", "evidence", "flow", "report"] as const),
      relativePath: Type.String({ description: "Artifact path relative to the configured root" }),
      configPath: Type.Optional(Type.String({ description: "Path to wiki.yaml relative to the project root" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const loaded = await activeConfig(ctx.cwd, params.configPath);
      const target = artifactPath(loaded, params.kind, params.relativePath);
      return {
        content: [{ type: "text", text: `${params.kind}: ${target}` }],
        details: { kind: params.kind, target, configPath: loaded.configPath },
      };
    },
  });

  pi.registerTool({
    name: "spiderverse_checksum_script",
    label: "Plan Page Text Checksum",
    description: "Return browser-eval JavaScript that hashes configured visible text inside the page and returns only SHA-256 plus counts. Raw text never enters Pi tool-call history.",
    promptSnippet: "Create a safe browser-eval script for a configured visible-text checksum",
    promptGuidelines: ["Use spiderverse_checksum_script after replaying a safe browser flow, then execute its script through browser_action eval without recording that observation."],
    parameters: Type.Object({
      configPath: Type.Optional(Type.String({ description: "Path to wiki.yaml relative to the project root" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const loaded = await activeConfig(ctx.cwd, params.configPath);
      const selectors = loaded.config.change_detection?.text_selectors;
      if (!Array.isArray(selectors) || selectors.length === 0 || !selectors.every((value: unknown) => typeof value === "string")) {
        throw new WikiConfigError("change_detection.text_selectors must be a non-empty string array");
      }
      const selector = selectors.join(",");
      const ignoreSelector = loaded.config.change_detection?.ignore_selector ?? "[data-spiderverse-ignore]";
      const script = `(async()=>{const selector=${JSON.stringify(selector)};const ignore=${JSON.stringify(ignoreSelector)};const values=[...document.querySelectorAll(selector)].filter(node=>!node.closest(ignore)).map(node=>(node.innerText||"").replace(/\\s+/g," ").trim()).filter(Boolean);const normalized=values.join("\\n");const bytes=new TextEncoder().encode(normalized);const digest=await crypto.subtle.digest("SHA-256",bytes);const checksum=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");return JSON.stringify({checksum:"sha256:"+checksum,textNodes:values.length,characters:normalized.length});})()`;
      return {
        content: [{ type: "text", text: script }],
        details: { selectors, ignoreSelector: String(ignoreSelector) },
      };
    },
  });

  pi.registerTool({
    name: "spiderverse_compare_fingerprint",
    label: "Compare Page Fingerprints",
    description: "Compare two page-text SHA-256 checksums and report whether documentation review is needed. This tool never writes files.",
    promptSnippet: "Compare a current and baseline website text fingerprint",
    promptGuidelines: ["Use spiderverse_compare_fingerprint after executing the script from spiderverse_checksum_script to decide whether a page should be reviewed or its wiki refreshed."],
    parameters: Type.Object({
      baseline: Type.String({ description: "Previously stored SHA-256 checksum" }),
      current: Type.String({ description: "Current SHA-256 checksum" }),
      page: Type.Optional(Type.String({ description: "Human-readable page name" })),
    }),
    async execute(_id, params) {
      const changed = params.baseline.replace(/^sha256:/, "") !== params.current.replace(/^sha256:/, "");
      const name = params.page ? ` for ${params.page}` : "";
      return {
        content: [{ type: "text", text: changed
          ? `Changed${name}: review and potentially refresh the wiki.`
          : `Unchanged${name}: no text-based wiki refresh is needed.` }],
        details: { changed, baseline: params.baseline, current: params.current, page: params.page },
      };
    },
  });

  // A publication guard for built-in writes. It applies only to configured public
  // artifact roots and deliberately leaves private evidence roots available for
  // approved internal tooling.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    try {
      const loaded = await activeConfig(ctx.cwd);
      const input = event.input as { path?: string; content?: string; edits?: unknown };
      if (!input.path) return;
      const target = resolve(ctx.cwd, input.path);
      const isImageArtifact = isContained(loaded.roots.image_root, target);
      const isPublicArtifact = isContained(loaded.roots.markdown_root, target) || isImageArtifact;
      if (!isPublicArtifact) return;
      if (isImageArtifact && ![".png", ".jpg", ".jpeg", ".webp"].includes(extname(target).toLowerCase())) {
        return { block: true, reason: "Spiderverse wiki images must be screenshot-derived PNG, JPEG, or WebP files." };
      }
      const body = input.content ?? input.edits;
      if (hasSensitiveContent(body) || /\.har$/i.test(target)) {
        return {
          block: true,
          reason: "Spiderverse blocked sensitive or raw-HAR content in a customer-facing artifact root.",
        };
      }
    } catch (error) {
      if (error instanceof WikiConfigError) {
        return { block: true, reason: `Spiderverse configuration invalid: ${error.message}` };
      }
      return { block: true, reason: `Spiderverse safety check failed: ${(error as Error).message}` };
    }
  });
}
