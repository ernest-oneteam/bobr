// Deploy the artifact already built and tested by Bazel. Never run a build here.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [directory, target] = process.argv.slice(2);
if (!directory || !["preview", "production"].includes(target)) {
  throw new Error(
    "Usage: node scripts/deploy-vercel.cjs DIRECTORY preview|production",
  );
}
for (const key of ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"]) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}
const cwd = path.resolve(directory);
const output = path.join(cwd, ".vercel/output");
require("../tools/bazel/check-artifact.cjs")(output);
const build = JSON.parse(fs.readFileSync(path.join(output, "builds.json")));
if (build.target !== target)
  throw new Error(`Artifact target ${build.target} does not match ${target}`);
const platform = JSON.parse(
  fs.readFileSync(path.join(output, "bobr-build.json")),
);
if (
  platform.platform !== "linux" ||
  platform.arch !== "x64" ||
  platform.node !== 22
) {
  throw new Error(
    "Vercel deployment requires the Linux x64 Node 22 CI artifact",
  );
}
fs.writeFileSync(
  path.join(cwd, ".vercel/project.json"),
  JSON.stringify({
    orgId: process.env.VERCEL_ORG_ID,
    projectId: process.env.VERCEL_PROJECT_ID,
  }),
);
const cli = path.join(
  path.dirname(require.resolve("vercel/package.json")),
  "dist/vc.js",
);
const result = spawnSync(
  process.execPath,
  [
    cli,
    "deploy",
    "--prebuilt",
    "--yes",
    ...(target === "production" ? ["--prod"] : []),
  ],
  {
    cwd,
    stdio: "inherit",
    env: { ...process.env, VERCEL_TELEMETRY_DISABLED: "1" },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
