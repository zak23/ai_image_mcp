import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { generateWithComfy } from "./comfy.js";
import { loadDotEnvSync } from "./env.js";
import { ensureDir, isPathInside, makeFilename, writeFile } from "./util.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
loadDotEnvSync(path.join(repoRoot, ".env"));

const config = {
  comfyBaseUrl: process.env.COMFYUI_BASE_URL ?? "http://127.0.0.1:8188",
  workflowPath: path.resolve(process.env.COMFYUI_WORKFLOW_PATH ?? path.join(repoRoot, "image_z_image_turbo.json")),
  outputDir: path.resolve(process.env.AI_IMAGE_OUTPUT_DIR ?? path.join(repoRoot, "assets/generated")),
  timeoutMs: parseInt(process.env.AI_IMAGE_TIMEOUT_MS ?? "60000", 10),
  pollIntervalMs: parseInt(process.env.AI_IMAGE_POLL_INTERVAL_MS ?? "800", 10),
  maxDimension: 1024,
  workspaceCwd: process.cwd(),
  autoCopyToWorkspace: process.env.AI_IMAGE_AUTO_COPY_TO_WORKSPACE !== "0",
  allowExternalOutput: process.env.AI_IMAGE_ALLOW_EXTERNAL_OUTPUT !== "0"
};

const generateImageInput = z.object({
  prompt: z.string().min(1).max(2000),
  width: z.coerce.number().int().min(1).default(1024),
  height: z.coerce.number().int().min(1).default(1024),
  seed: z.coerce.number().int().nonnegative().optional(),
  filename: z.string().min(1).max(255).optional(),
  outputPath: z.string().min(1).max(1024).optional(),
  copyToPath: z.string().min(1).max(2048).optional(),
  workingDirectory: z.string().min(1).max(2048).optional(),
  cwd: z.string().min(1).max(2048).optional(),
  returnBase64: z.boolean().default(true)
});

const TOOL_ALIASES = [
  "generate_image",
  "create_image",
  "make_image",
  "quick_image",
  "image_from_prompt"
] as const;

const server = new Server(
  {
    name: "ai-image-mcp",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOL_ALIASES.map((toolName) => ({
      name: toolName,
      description:
        toolName === "quick_image"
          ? "Quick text-to-image generation via self-hosted ComfyUI with sane defaults (saves file + returns base64)."
          : "Generate an image via a self-hosted ComfyUI workflow and return base64 plus saved file path.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Text prompt for image generation" },
          width: { type: "integer", minimum: 1, maximum: config.maxDimension, default: 1024 },
          height: { type: "integer", minimum: 1, maximum: config.maxDimension, default: 1024 },
          seed: { type: "integer", minimum: 0, description: "Optional seed" },
          filename: { type: "string", description: "Optional output filename (.png suggested)" },
          outputPath: { type: "string", description: "Optional project-relative output path (overrides default output dir)" },
          copyToPath: { type: "string", description: "Optional path to also copy the image to (absolute, or relative to current workspace cwd)" },
          workingDirectory: {
            type: "string",
            description: "Optional working directory used to resolve relative copyToPath and auto-copy target"
          },
          cwd: {
            type: "string",
            description: "Alias for workingDirectory"
          },
          returnBase64: { type: "boolean", default: true }
        },
        required: ["prompt"]
      }
    }))
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!TOOL_ALIASES.includes(request.params.name as (typeof TOOL_ALIASES)[number])) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const rawArgs = { ...(request.params.arguments ?? {}) } as Record<string, unknown>;
  if (request.params.name === "quick_image" && rawArgs.returnBase64 === undefined) {
    rawArgs.returnBase64 = false;
  }

  const parsed = generateImageInput.parse(rawArgs);
  const requestWorkspaceCwd =
    parsed.workingDirectory?.trim() ||
    parsed.cwd?.trim() ||
    resolveRequestWorkspaceCwd(request.params);
  const { width, height } = normalizeDimensions(parsed.width, parsed.height);
  const requestedFilename = normalizeFilename(parsed.filename ?? makeFilename(parsed.prompt));

  const outputFile = resolveOutputPath(parsed.outputPath, requestedFilename);
  await ensureDir(path.dirname(outputFile));

  const generation = await generateWithComfy({
    baseUrl: config.comfyBaseUrl,
    workflowPath: config.workflowPath,
    prompt: parsed.prompt,
    width,
    height,
    seed: parsed.seed,
    timeoutMs: config.timeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    filenamePrefix: path.parse(requestedFilename).name
  });

  await writeFile(generation.buffer, outputFile);
  const copiedToPath = await maybeCopyToWorkspace(
    generation.buffer,
    parsed.copyToPath,
    requestedFilename,
    outputFile,
    requestWorkspaceCwd
  );

  const base64 = parsed.returnBase64 ? generation.buffer.toString("base64") : undefined;
  const result = {
    success: true,
    prompt: parsed.prompt,
    filename: path.basename(outputFile),
    savedPath: path.relative(repoRoot, outputFile),
    mimeType: generation.mimeType,
    seed: generation.seed,
    width: generation.width,
    height: generation.height,
    durationMs: generation.durationMs,
    comfyPromptId: generation.comfyPromptId,
    requestedWidth: parsed.width,
    requestedHeight: parsed.height,
    copiedToPath,
    workspaceCwdUsedForCopy: requestWorkspaceCwd ?? config.workspaceCwd
  };

  const structuredContent = parsed.returnBase64 ? { ...result, base64 } : result;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ...structuredContent,
            base64: base64 ? `[base64 ${base64.length} chars]` : undefined
          },
          null,
          2
        )
      },
      ...(base64
        ? [
            {
              type: "image" as const,
              data: base64,
              mimeType: generation.mimeType
            }
          ]
        : [])
    ],
    structuredContent
  };
});

server.onerror = (error) => {
  console.error("[mcp-error]", error);
};

async function main(): Promise<void> {
  await logStartupHealth();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[ai-image-mcp] connected via stdio; tools=${TOOL_ALIASES.join(", ")} comfy=${config.comfyBaseUrl}`
  );
}

function normalizeFilename(name: string): string {
  const base = path.basename(name);
  return /\.(png|jpg|jpeg|webp)$/i.test(base) ? base : `${base}.png`;
}

function resolveOutputPath(outputPath: string | undefined, filename: string): string {
  if (!outputPath) {
    return path.join(config.outputDir, filename);
  }

  const maybeAbs = path.resolve(repoRoot, outputPath);
  const finalPath = path.extname(maybeAbs) ? maybeAbs : path.join(maybeAbs, filename);
  if (!config.allowExternalOutput && !isPathInside(repoRoot, finalPath)) {
    throw new Error("outputPath must stay inside the project directory");
  }
  return finalPath;
}

function normalizeDimensions(requestedWidth: number, requestedHeight: number): { width: number; height: number } {
  const clamp = (n: number) => Math.max(1, Math.min(config.maxDimension, n));
  const roundTo64 = (n: number) => Math.max(64, Math.round(n / 64) * 64);

  const width = clamp(roundTo64(requestedWidth));
  const height = clamp(roundTo64(requestedHeight));

  return { width, height };
}

async function logStartupHealth(): Promise<void> {
  const checks = {
    workflowExists: false,
    outputDirReady: false
  };

  try {
    await fs.access(config.workflowPath);
    checks.workflowExists = true;
  } catch {
    checks.workflowExists = false;
  }

  try {
    await ensureDir(config.outputDir);
    checks.outputDirReady = true;
  } catch {
    checks.outputDirReady = false;
  }

  console.error(
    `[ai-image-mcp] startup cwd=${config.workspaceCwd} comfy=${config.comfyBaseUrl} workflow=${config.workflowPath} workflowExists=${checks.workflowExists} outputDir=${config.outputDir} outputDirReady=${checks.outputDirReady} autoCopyToWorkspace=${config.autoCopyToWorkspace} allowExternalOutput=${config.allowExternalOutput} max=${config.maxDimension}`
  );
}

async function maybeCopyToWorkspace(
  buffer: Buffer,
  copyToPath: string | undefined,
  filename: string,
  primaryOutputFile: string,
  workspaceCwdOverride?: string
): Promise<string | undefined> {
  const workspaceCwd = path.resolve(workspaceCwdOverride ?? config.workspaceCwd);
  const target = resolveWorkspaceCopyPath(copyToPath, filename, workspaceCwd);
  if (!target) return undefined;

  const primaryReal = path.resolve(primaryOutputFile);
  const targetReal = path.resolve(target);
  if (primaryReal === targetReal) {
    return path.relative(workspaceCwd, targetReal);
  }

  await writeFile(buffer, targetReal);
  return path.relative(workspaceCwd, targetReal);
}

function resolveWorkspaceCopyPath(
  copyToPath: string | undefined,
  filename: string,
  workspaceCwd: string
): string | undefined {
  if (copyToPath) {
    if (path.isAbsolute(copyToPath)) {
      return path.extname(copyToPath) ? copyToPath : path.join(copyToPath, filename);
    }
    const resolved = path.resolve(workspaceCwd, copyToPath);
    return path.extname(resolved) ? resolved : path.join(resolved, filename);
  }

  if (!config.autoCopyToWorkspace) return undefined;
  if (workspaceCwd === path.resolve(repoRoot)) return undefined;

  return path.join(workspaceCwd, "assets", "generated", filename);
}

function resolveRequestWorkspaceCwd(params: { arguments?: Record<string, unknown> } & Record<string, unknown>): string | undefined {
  const args = params.arguments;
  if (args && typeof args === "object") {
    const argValue = firstString(
      (args as Record<string, unknown>).workspaceCwd,
      (args as Record<string, unknown>).cwd,
      (args as Record<string, unknown>).projectRoot
    );
    if (argValue) return argValue;
  }

  const metaCandidates = [
    (params as Record<string, unknown>)._meta,
    (params as Record<string, unknown>).meta
  ];
  for (const candidate of metaCandidates) {
    const found = findWorkspacePath(candidate);
    if (found) return found;
  }

  return undefined;
}

function findWorkspacePath(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;

  const direct = firstString(
    obj.workspaceCwd,
    obj.cwd,
    obj.workspaceRoot,
    obj.projectRoot,
    obj.rootPath,
    obj.workingDirectory
  );
  if (direct) return direct;

  const uri = firstString(obj.workspaceUri, obj.rootUri, obj.projectUri);
  if (uri) {
    const fromUri = fileUriToPath(uri);
    if (fromUri) return fromUri;
  }

  for (const nestedKey of ["client", "cursor", "context", "workspace", "project"]) {
    const nested = findWorkspacePath(obj[nestedKey]);
    if (nested) return nested;
  }

  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function fileUriToPath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
