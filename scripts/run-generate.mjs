/**
 * One-off runner for generate_image logic (same as MCP tool).
 * Usage: node scripts/run-generate.mjs --prompt "..." [--width 768] [--height 768] [--outputPath assets/generated]
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};

const prompt = getArg("--prompt");
const width = parseInt(getArg("--width") ?? "1024", 10);
const height = parseInt(getArg("--height") ?? "1024", 10);
const outputPath = getArg("--outputPath");

if (!prompt) {
  console.error("Usage: node scripts/run-generate.mjs --prompt \"...\" [--width 768] [--height 768] [--outputPath assets/generated]");
  process.exit(1);
}

function loadDotEnvSync(filePath) {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

async function main() {
  loadDotEnvSync(path.join(repoRoot, ".env"));

  const { generateWithComfy } = await import("../dist/comfy.js");
  const { ensureDir, isPathInside, makeFilename, writeFile } = await import("../dist/util.js");

  const config = {
    comfyBaseUrl: process.env.COMFYUI_BASE_URL ?? "http://127.0.0.1:8188",
    workflowPath: path.resolve(process.env.COMFYUI_WORKFLOW_PATH ?? path.join(repoRoot, "image_z_image_turbo.json")),
    outputDir: path.resolve(process.env.AI_IMAGE_OUTPUT_DIR ?? path.join(repoRoot, "assets/generated")),
    timeoutMs: parseInt(process.env.AI_IMAGE_TIMEOUT_MS ?? "60000", 10),
    pollIntervalMs: parseInt(process.env.AI_IMAGE_POLL_INTERVAL_MS ?? "800", 10),
    maxDimension: 1024
  };

  const clamp = (n) => Math.max(1, Math.min(config.maxDimension, n));
  const roundTo64 = (n) => Math.max(64, Math.round(n / 64) * 64);
  const w = clamp(roundTo64(width));
  const h = clamp(roundTo64(height));

  const requestedFilename = makeFilename(prompt);
  let outputFile;
  if (!outputPath) {
    outputFile = path.join(config.outputDir, requestedFilename);
  } else {
    const maybeAbs = path.resolve(repoRoot, outputPath);
    const finalPath = path.extname(maybeAbs) ? maybeAbs : path.join(maybeAbs, requestedFilename);
    if (!isPathInside(repoRoot, finalPath)) {
      throw new Error("outputPath must stay inside the project directory");
    }
    outputFile = finalPath;
  }

  await ensureDir(path.dirname(outputFile));

  const generation = await generateWithComfy({
    baseUrl: config.comfyBaseUrl,
    workflowPath: config.workflowPath,
    prompt,
    width: w,
    height: h,
    timeoutMs: config.timeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    filenamePrefix: path.parse(requestedFilename).name
  });

  await writeFile(generation.buffer, outputFile);

  const result = {
    success: true,
    prompt,
    filename: path.basename(outputFile),
    savedPath: path.relative(repoRoot, outputFile),
    mimeType: generation.mimeType,
    seed: generation.seed,
    width: generation.width,
    height: generation.height,
    durationMs: generation.durationMs,
    comfyPromptId: generation.comfyPromptId
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
