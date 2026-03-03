import assert from "node:assert";
import path from "node:path";
import test from "node:test";
import { isPathInside, makeFilename, slugify } from "./util.js";

test("slugify: normalizes to lowercase alphanumeric and hyphens", () => {
  assert.strictEqual(slugify("Hello World"), "hello-world");
  assert.strictEqual(slugify("Cozy Coffee Shop"), "cozy-coffee-shop");
  assert.strictEqual(slugify("UPPERCASE"), "uppercase");
});

test("slugify: strips leading/trailing hyphens", () => {
  assert.strictEqual(slugify("  spaces  "), "spaces");
  assert.strictEqual(slugify("---lead-trail---"), "lead-trail");
});

test("slugify: collapses non-alphanumeric to single hyphen", () => {
  assert.strictEqual(slugify("a___b!!!c"), "a-b-c");
});

test("slugify: truncates to 48 chars", () => {
  const long = "a".repeat(60);
  assert.strictEqual(slugify(long).length, 48);
});

test("slugify: empty or only symbols yields 'image'", () => {
  assert.strictEqual(slugify(""), "image");
  assert.strictEqual(slugify("!!!---!!!"), "image");
});

test("makeFilename: returns string ending with .png and containing slug", () => {
  const name = makeFilename("test prompt");
  assert.ok(name.endsWith(".png"));
  assert.ok(name.includes("test-prompt"));
  assert.match(name, /^\S+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
});

test("isPathInside: child inside parent", () => {
  const parent = path.resolve("/repo");
  assert.strictEqual(isPathInside(parent, path.join(parent, "assets/generated")), true);
  assert.strictEqual(isPathInside(parent, path.join(parent, "a", "b")), true);
  assert.strictEqual(isPathInside(parent, parent), true);
});

test("isPathInside: child outside parent", () => {
  const parent = path.resolve("/repo");
  assert.strictEqual(isPathInside(parent, "/other/file"), false);
  assert.strictEqual(isPathInside(parent, "/tmp/outside"), false);
});

test("isPathInside: same dir is inside", () => {
  const dir = path.resolve("/repo/assets");
  assert.strictEqual(isPathInside(dir, dir), true);
});
