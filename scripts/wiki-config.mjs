import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import YAML from "yaml";

const ARTIFACT_KEYS = ["markdown_root", "image_root", "evidence_root", "flow_root", "report_root"];

export class WikiConfigError extends Error {}

export function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WikiConfigError(`${name} must be a non-empty string`);
  }
  return value;
}

function rejectUnknown(object, allowed, section) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return;
  const unknown = Object.keys(object).find(key => !allowed.includes(key));
  if (unknown) throw new WikiConfigError(`${section} contains unknown metadata`);
}

export function validateConfig(config) {
  if (!config || typeof config !== "object") throw new WikiConfigError("Configuration must be a YAML object");
  rejectUnknown(config, ["schema_version", "site", "authentication", "artifacts", "output", "change_detection", "execution", "publication", "content", "expansion", "scope", "flows", "safety"], "configuration");
  rejectUnknown(config.site, ["id", "title", "base_url", "audience"], "site");
  rejectUnknown(config.authentication, ["mode", "profile", "record"], "authentication");
  rejectUnknown(config.artifacts, ARTIFACT_KEYS, "artifacts");
  rejectUnknown(config.output, ["index", "area_directory", "workflow_directory", "reference_directory"], "output");
  rejectUnknown(config.change_detection, ["text_selectors", "ignore_selector"], "change_detection");
  rejectUnknown(config.execution, ["model", "max_steps", "max_pages", "max_depth", "timeout_minutes", "pass_env"], "execution");
  rejectUnknown(config.publication, ["data_policy"], "publication");
  rejectUnknown(config.content, ["document", "screenshots", "language", "external_links"], "content");
  rejectUnknown(config.expansion, ["strategy", "preserve_existing", "batch_size", "require_live_verification", "require_empty_state", "require_flow_provenance", "require_current_replay", "require_screenshot", "blocked_output"], "expansion");
  rejectUnknown(config.scope, ["include_areas", "exclude_areas", "exclude_actions"], "scope");
  rejectUnknown(config.flows, ["gitignore", "markdown_metadata", "include", "pages"], "flows");
  rejectUnknown(config.safety, ["customer_safe", "screenshot_only_images", "synthetic_test_data", "allowed_side_effects", "forbidden_content"], "safety");
  if (config.schema_version !== 1) throw new WikiConfigError("schema_version must be 1");
  requireString(config.site?.id, "site.id");
  requireString(config.site?.title, "site.title");
  requireString(config.site?.base_url, "site.base_url");
  try { new URL(config.site.base_url); } catch { throw new WikiConfigError("site.base_url must be a URL"); }
  for (const key of ARTIFACT_KEYS) requireString(config.artifacts?.[key], `artifacts.${key}`);
  for (const key of ["index", "area_directory", "workflow_directory", "reference_directory"]) {
    requireString(config.output?.[key], `output.${key}`);
  }
  if (config.safety?.customer_safe !== true) throw new WikiConfigError("safety.customer_safe must be true");
  if (config.safety?.screenshot_only_images !== true) throw new WikiConfigError("safety.screenshot_only_images must be true");
  if (!Array.isArray(config.safety?.allowed_side_effects) || !config.safety.allowed_side_effects.includes("none")) {
    throw new WikiConfigError("safety.allowed_side_effects must include none");
  }
  if (!Array.isArray(config.safety?.forbidden_content)) throw new WikiConfigError("safety.forbidden_content must be an array");
  const forbiddenCategories = new Set(["credentials", "cookies", "session-identifiers", "raw-har", "internal-hostnames", "internal-urls", "personal-data", "payroll-data"]);
  if (config.safety.forbidden_content.some(value => !forbiddenCategories.has(value))) {
    throw new WikiConfigError("safety.forbidden_content contains an unknown category");
  }
  if (config.authentication !== undefined) {
    if (!config.authentication || typeof config.authentication !== "object") throw new WikiConfigError("authentication must be an object");
    if (config.authentication.mode !== undefined) requireString(config.authentication.mode, "authentication.mode");
    if (config.authentication.profile !== undefined) requireString(config.authentication.profile, "authentication.profile");
    if (config.authentication.record !== undefined && config.authentication.record !== false) {
      throw new WikiConfigError("authentication.record must be false");
    }
  }
  if (config.content !== undefined) {
    if (!config.content || typeof config.content !== "object") throw new WikiConfigError("content must be an object");
    const allowed = new Set(["pages", "features", "navigation", "workflows"]);
    if (config.content.document !== undefined && (!Array.isArray(config.content.document) || config.content.document.some(value => !allowed.has(value)))) {
      throw new WikiConfigError("content.document contains an unsupported content type");
    }
    if (config.content.screenshots !== undefined && typeof config.content.screenshots !== "boolean") {
      throw new WikiConfigError("content.screenshots must be a boolean");
    }
    if (config.content.language !== undefined) requireString(config.content.language, "content.language");
    if (config.content.external_links !== undefined && !["deny", "allow-public"].includes(config.content.external_links)) {
      throw new WikiConfigError("content.external_links must be deny or allow-public");
    }
  }
  if (config.execution !== undefined) {
    if (!config.execution || typeof config.execution !== "object") throw new WikiConfigError("execution must be an object");
    if (config.execution.model !== undefined) requireString(config.execution.model, "execution.model");
    for (const key of ["max_steps", "max_pages", "timeout_minutes"]) {
      if (config.execution[key] !== undefined && (!Number.isInteger(config.execution[key]) || config.execution[key] < 1)) {
        throw new WikiConfigError(`execution.${key} must be a positive integer`);
      }
    }
    if (config.execution.max_depth !== undefined && (!Number.isInteger(config.execution.max_depth) || config.execution.max_depth < 0)) {
      throw new WikiConfigError("execution.max_depth must be a non-negative integer");
    }
    if (config.execution.pass_env !== undefined) {
      if (!Array.isArray(config.execution.pass_env) || config.execution.pass_env.some(name => !/^[A-Z_][A-Z0-9_]*$/.test(name))) {
        throw new WikiConfigError("execution.pass_env must contain environment variable names");
      }
      if (config.execution.pass_env.some(name => /(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|SESSION|AUTH)/.test(name))) {
        throw new WikiConfigError("execution.pass_env cannot include credential variables");
      }
    }
  }
  for (const section of ["scope", "publication"]) {
    if (config[section] !== undefined && (!config[section] || typeof config[section] !== "object")) throw new WikiConfigError(`${section} must be an object`);
  }
  if (config.publication?.data_policy !== undefined && !["protected", "synthetic-test-data"].includes(config.publication.data_policy)) {
    throw new WikiConfigError("publication.data_policy must be protected or synthetic-test-data");
  }
  if (config.safety?.synthetic_test_data !== undefined && typeof config.safety.synthetic_test_data !== "boolean") {
    throw new WikiConfigError("safety.synthetic_test_data must be a boolean");
  }
  for (const key of ["include_areas", "exclude_areas", "exclude_actions"]) {
    if (config.scope?.[key] !== undefined && (!Array.isArray(config.scope[key]) || config.scope[key].some(value => typeof value !== "string" || !value.trim()))) {
      throw new WikiConfigError(`scope.${key} must be an array of non-empty strings`);
    }
  }
  if (config.expansion !== undefined) {
    if (!config.expansion || typeof config.expansion !== "object") throw new WikiConfigError("expansion must be an object");
    if (config.expansion.batch_size !== undefined && (!Number.isInteger(config.expansion.batch_size) || config.expansion.batch_size < 1)) {
      throw new WikiConfigError("expansion.batch_size must be a positive integer");
    }
    for (const key of ["preserve_existing", "require_live_verification", "require_empty_state", "require_flow_provenance", "require_current_replay", "require_screenshot"]) {
      if (config.expansion[key] !== undefined && typeof config.expansion[key] !== "boolean") {
        throw new WikiConfigError(`expansion.${key} must be a boolean`);
      }
    }
    if (config.expansion.blocked_output !== undefined && !["private-report-only", "customer-gap-page"].includes(config.expansion.blocked_output)) {
      throw new WikiConfigError("expansion.blocked_output must be private-report-only or customer-gap-page");
    }
  }
  if (config.flows !== undefined) {
    if (!config.flows || typeof config.flows !== "object") throw new WikiConfigError("flows must be an object");
    if (!Array.isArray(config.flows.include) || config.flows.include.some(value => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))) {
      throw new WikiConfigError("flows.include must contain basename-safe flow names");
    }
    if (config.flows.gitignore !== undefined && typeof config.flows.gitignore !== "boolean") {
      throw new WikiConfigError("flows.gitignore must be a boolean");
    }
    if (config.flows.markdown_metadata !== undefined && typeof config.flows.markdown_metadata !== "boolean") {
      throw new WikiConfigError("flows.markdown_metadata must be a boolean");
    }
    if (config.flows.pages !== undefined && (!config.flows.pages || typeof config.flows.pages !== "object" || Array.isArray(config.flows.pages))) {
      throw new WikiConfigError("flows.pages must be a Markdown-path mapping");
    }
  }
  return config;
}

async function canonicalPlannedPath(path) {
  let existing = path;
  const missing = [];
  while (true) {
    try { return resolve(await realpath(existing), ...missing); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

export async function loadWikiConfig(configPath, cwd = process.cwd()) {
  const projectRoot = await realpath(resolve(cwd));
  const absoluteConfig = await realpath(resolve(projectRoot, configPath));
  if (!isContained(projectRoot, absoluteConfig)) throw new WikiConfigError("configuration escapes the project root");
  const config = validateConfig(YAML.parse(await readFile(absoluteConfig, "utf8")));
  // Configured paths are anchored at the caller's project root. Resolve any
  // existing symlink ancestors before containment checks, including roots that
  // Pi has not created yet.
  const roots = Object.fromEntries(await Promise.all(ARTIFACT_KEYS.map(async key => [
    key,
    await canonicalPlannedPath(resolve(projectRoot, config.artifacts[key])),
  ])));
  for (const [key, path] of Object.entries(roots)) {
    if (!isContained(projectRoot, path)) throw new WikiConfigError(`artifacts.${key} escapes the project root`);
  }
  const publicRoots = [roots.markdown_root, roots.image_root];
  for (const privateRoot of [roots.evidence_root, roots.flow_root, roots.report_root]) {
    if (publicRoots.some((publicRoot) => isContained(publicRoot, privateRoot) || isContained(privateRoot, publicRoot))) {
      throw new WikiConfigError("Private evidence/flow/report roots must not overlap public Markdown or image roots");
    }
  }
  return { config, configPath: absoluteConfig, roots, projectRoot };
}

export function artifactPath(loaded, kind, relativePath) {
  const rootKey = `${kind}_root`;
  const root = loaded.roots[rootKey];
  if (!root) throw new WikiConfigError(`Unknown artifact kind: ${kind}`);
  const target = resolve(root, relativePath);
  if (!isContained(root, target)) throw new WikiConfigError("Artifact path escapes its configured root");
  return target;
}
