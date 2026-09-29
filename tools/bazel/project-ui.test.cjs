const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const projectUi = require("./project-ui.cjs");

function fixture(t, appSource, utilitySource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ui-projection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  const source = path.join(root, "ui");
  const output = path.join(root, "output");
  fs.mkdirSync(app);
  fs.mkdirSync(path.join(source, "src/utils"), { recursive: true });
  fs.writeFileSync(path.join(app, "page.ts"), appSource);
  fs.writeFileSync(path.join(source, "src/utils/index.ts"), utilitySource);
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({
      sideEffects: false,
      exports: { "./utils": "./src/utils/index.ts", "./*": "./src/*.tsx" },
    }),
  );
  return { app, source, output, run: () => projectUi(app, source, output) };
}

// Namespace reflection can observe exports that the app never names explicitly.
test("namespace import retains every export, including default", async (t) => {
  const f = fixture(
    t,
    'import * as utils from "@repo/ui/utils";',
    "export const used = 1; export const unseen = 2; export default 3;",
  );
  await f.run();
  const contents = fs.readFileSync(
    path.join(f.output, "utils/index.js"),
    "utf8",
  );
  const result = await import(
    `data:text/javascript;base64,${Buffer.from(contents).toString("base64")}`
  );
  assert.deepEqual({ ...result }, { used: 1, unseen: 2, default: 3 });
});

test("sideEffects and PURE annotations cannot hide an observable initializer", async (t) => {
  const f = fixture(
    t,
    'import { used } from "@repo/ui/utils";',
    "export const used = 1; const unused = /* @__PURE__ */ (() => { globalThis.__projectionTest = 42; })();",
  );
  await f.run();
  const contents = fs.readFileSync(
    path.join(f.output, "utils/index.js"),
    "utf8",
  );
  await import(
    `data:text/javascript;base64,${Buffer.from(contents).toString("base64")}`
  );
  assert.equal(globalThis.__projectionTest, 42);
  delete globalThis.__projectionTest;
});

for (const [name, app, utility, error] of [
  [
    "direct utility subpath",
    'import { used } from "@repo/ui/utils/leaf";',
    "export const used = 1;",
    /direct utility imports/,
  ],
  [
    "computed app import",
    'import("@repo/ui/" + name);',
    "export const used = 1;",
    /computed imports/,
  ],
  [
    "client directive",
    'import { used } from "@repo/ui/utils";',
    '"use client"; export const used = 1;',
    /directives/,
  ],
  [
    "nested server directive",
    'import { used } from "@repo/ui/utils";',
    'export async function used() { "use server"; }',
    /directives/,
  ],
  [
    "dynamic utility import",
    'import { used } from "@repo/ui/utils";',
    'export const used = () => import("./other");',
    /static ESM/,
  ],
]) {
  test(`rejects unsupported ${name}`, async (t) => {
    const f = fixture(t, app, utility);
    await assert.rejects(f.run(), error);
  });
}
