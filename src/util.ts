import fs from "node:fs/promises";
import path from "node:path";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowMs(): number {
  return Date.now();
}

export function randomSeed(): number {
  const maxSafe = Number.MAX_SAFE_INTEGER;
  return Math.floor(Math.random() * maxSafe);
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "image";
}

export function makeFilename(prompt: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${slugify(prompt)}-${stamp}.png`;
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeFile(buffer: Buffer, filePath: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, buffer);
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
