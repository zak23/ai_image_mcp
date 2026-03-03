import assert from "node:assert";
import test from "node:test";
import { z } from "zod";

const maxDimension = 1024;
const generateImageInput = z.object({
  prompt: z.string().min(1).max(2000),
  width: z.number().int().min(1).max(maxDimension).default(1024),
  height: z.number().int().min(1).max(maxDimension).default(1024),
  seed: z.number().int().nonnegative().optional(),
  filename: z.string().min(1).max(255).optional(),
  outputPath: z.string().min(1).max(1024).optional(),
  returnBase64: z.boolean().default(true)
});

test("parse: requires prompt", () => {
  assert.throws(() => generateImageInput.parse({}), { message: /prompt/ });
  assert.throws(() => generateImageInput.parse({ prompt: "" }), { message: /prompt/ });
});

test("parse: valid minimal args", () => {
  const out = generateImageInput.parse({ prompt: "a cozy cafe" });
  assert.strictEqual(out.prompt, "a cozy cafe");
  assert.strictEqual(out.width, 1024);
  assert.strictEqual(out.height, 1024);
  assert.strictEqual(out.returnBase64, true);
});

test("parse: valid with optional args", () => {
  const out = generateImageInput.parse({
    prompt: "sunset",
    width: 512,
    height: 768,
    seed: 42,
    filename: "out.png",
    returnBase64: false
  });
  assert.strictEqual(out.width, 512);
  assert.strictEqual(out.height, 768);
  assert.strictEqual(out.seed, 42);
  assert.strictEqual(out.filename, "out.png");
  assert.strictEqual(out.returnBase64, false);
});

test("parse: rejects width/height out of range", () => {
  assert.throws(() => generateImageInput.parse({ prompt: "x", width: 0 }));
  assert.throws(() => generateImageInput.parse({ prompt: "x", width: 2048 }));
  assert.throws(() => generateImageInput.parse({ prompt: "x", height: 0 }));
  assert.throws(() => generateImageInput.parse({ prompt: "x", height: 2048 }));
});

test("parse: rejects negative seed", () => {
  assert.throws(() => generateImageInput.parse({ prompt: "x", seed: -1 }));
});
