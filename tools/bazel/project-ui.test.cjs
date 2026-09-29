const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const projectUi = require("./project-ui.cjs");
const esbuild = require("esbuild");

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

for (const specifier of ["./utils", "./utils/index", "./utils/index.js"]) {
  test(`a component's ${specifier} import preserves runtime effects`, async (t) => {
    const f = fixture(
      t,
      'import { Widget } from "@repo/ui/widget"; export const result = Widget();',
      "globalThis.__relativeProjectionEffect = 42;",
    );
    t.after(() => delete globalThis.__relativeProjectionEffect);
    fs.writeFileSync(
      path.join(f.source, "src/widget.tsx"),
      `import /* comment */ "${specifier}"; export const Widget = () => globalThis.__relativeProjectionEffect;`,
    );
    await f.run();
    const bundled = await esbuild.build({
      entryPoints: [path.join(f.app, "page.ts")],
      alias: { "@repo/ui": f.output },
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
    });
    const code = bundled.outputFiles[0].text + `\n// ${f.output}`;
    const result = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    );
    assert.equal(result.result, 42);
  });
}

test("relative named imports shake unused values and retain changed effects", async (t) => {
  const f = fixture(t, 'import "@repo/ui/widget";', "");
  fs.writeFileSync(
    path.join(f.source, "src/widget.tsx"),
    'import { used } from /* comment */ "./utils"; export const Widget = () => used;',
  );
  async function project(used, unused, effect) {
    fs.writeFileSync(
      path.join(f.source, "src/utils/index.ts"),
      `export const used = ${used}; export const unused = ${unused}; globalThis.__effect = ${effect};`,
    );
    await f.run();
    return fs.readFileSync(path.join(f.output, "utils/index.js"), "utf8");
  }
  const baseline = await project(1, 2, 3);
  assert.equal(await project(1, 99, 3), baseline);
  assert.notEqual(await project(9, 2, 3), baseline);
  assert.notEqual(await project(1, 2, 9), baseline);
});

for (const statement of [
  'import /* comment */ "./utils/leaf";',
  'export { used } from /* comment */ "./utils/leaf";',
  'import /* comment */ ("./utils/leaf");',
  'require /* comment */ ("./utils/leaf");',
  'import "./utils/index.ts";',
]) {
  test(`rejects unsupported relative path in ${statement}`, async (t) => {
    const f = fixture(t, 'import "@repo/ui/widget";', "export const used = 1;");
    fs.writeFileSync(path.join(f.source, "src/widget.tsx"), statement);
    await assert.rejects(
      f.run(),
      /relative utility imports must use the barrel/,
    );
  });
}

test("an ordinary string containing a utility path is not an import", async (t) => {
  const f = fixture(
    t,
    'export const label = "@repo/ui/utils/leaf";',
    'throw new Error("unimported utility evaluated");',
  );
  await f.run();
  assert.equal(
    fs.readFileSync(path.join(f.output, "utils/index.js"), "utf8").trim(),
    "",
  );
});

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
