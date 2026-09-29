# Bóbr

Bóbr tests whether a TypeScript monorepo can skip work when shared code changes
without affecting an app. Bazel owns cache keys. Developers write ordinary
imports, including imports through a barrel.

## Prove it against Next

```bash
pnpm test:bazel-next
# Or, without installing workspace dependencies:
python3 scripts/prove-next-invalidation.py
```

The script copies the current working tree into a temporary directory and runs
real `next build --webpack` actions. It changes files only in that copy, then
checks Bazel's execution logs and hashes the complete output directories as
test evidence. Those hashes do not control the build cache.

| Edit                                                | Web Next build | Docs Next build |
| --------------------------------------------------- | -------------- | --------------- |
| Unused export through the utility barrel            | Skipped        | Skipped         |
| Unused export in the same module as `add`           | Skipped        | Skipped         |
| Used `add` implementation                           | Executes       | Skipped         |
| Used `sub` implementation                           | Skipped        | Executes        |
| Side effect in an unused barrel branch              | Executes       | Executes        |
| Change that side effect                             | Executes       | Executes        |
| Delete local build outputs, restore from disk cache | Cache hit      | Cache hit       |

The proof also checks that retained effects appear in Next's browser chunks
and that Next's declared inputs contain no raw `@repo/ui` source package.
Each run prints the location of its JSON report and full action logs.

## The build boundary

```text
App imports + complete UI sources
             |
       UiProjection, esbuild
             |
  App-specific ui_runtime tree
             |
       NextBuild, webpack
             |
            .next
```

`UiProjection` reads app imports and bundles the utility barrel with only the
exports that app requests. It preserves module side effects, even when the
source package declares `sideEffects: false` or contains `PURE` annotations.
Namespace imports retain all exports. React components keep their original
files and directives.

An unused export edit reruns the projection. If it produces identical files,
Bazel reuses the existing Next artifact. This avoids executing Next at all,
so Next's nondeterministic output does not enter the comparison. No manifest
stripping, hand-maintained export hashes, or per-commit build IDs are involved.

Both apps call the shared `next_app_build` macro. Their source still imports
`@repo/ui/utils`; developers do not list used exports in BUILD files. The
projection supports local TypeScript utility modules with static ESM imports.
It rejects direct utility subpaths, computed app imports, dynamic imports inside
utilities, and React/server directives inside utilities. This is a bounded PoC,
not a general Next module optimizer. Adding a new Bazel subpackage still requires
including its sources in the UI source aggregation.

## Commands

```bash
bazel build //...
bazel test //apps/web:test //apps/docs:test //tools/bazel:project_ui_test
python3 scripts/prove-next-invalidation.py
```

The older `scripts/bazel-cache-demo.sh` demonstrates the separate TypeScript
unit-test cache. The Next proof above covers the barrel behavior in the actual
apps. `pnpm dev` continues to use the source package directly.

Bazel consumes `pnpm-lock.yaml` through rules_js. The projection pins esbuild
`0.28.1`. Ordinary CI builds and tests with Bazel and checks the full app and UI
types through pnpm. The eleven-case Next invalidation experiment runs separately
for build-system changes, weekly, or manually. Follow-up PR commits compare
against the previous head so app-only edits can skip the experiment.

## Remaining work

The verified cache restoration uses a local disk CAS on macOS arm64. The actions
are eligible for the configured remote cache, but this proof does not establish
artifact portability across machines or deployment environments. Build-time
configuration and fetched data need declared inputs before using this for apps
that depend on them.

Vercel Build Output packaging, deployment reuse, and Playwright checks against
the deployed artifact are not wired yet. Next's build skips application type
checking; CI checks original sources in a separate job. Those type-check results
are not yet cached by Bazel. Unreachable UI components still cause conservative
invalidation. See [the evaluation](spec/BAZEL_EVALUATION.md) for the remaining gaps.

See [the migration notes](spec/BAZEL_MIGRATION.md) for the Bazel graph and cache
mechanics. The earlier Nx and output-hashing approach remains in
[the optimization plan](spec/OPTIMIZATION_PLAN.md) and
[the hashing strategy](spec/HASHING_STRATEGY.md).
