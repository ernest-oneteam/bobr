# Bazel goal evaluation

Reviewed on 2026-09-29 at commit `68d9144`, PR #6 against `main`. The acceptance criteria come from the project discussion: unused exports must leave intermediate inputs unchanged, used exports and effects must invalidate correctly, developers should not maintain hashes, consecutive PR commits should reuse work, and Vercel should deploy the tested artifact.

We have proved the central cache mechanism for the supplied utility fixtures. We have not achieved the complete development, CI and deployment workflow. There is also a confirmed correctness defect in the projection's handling of relative side-effect imports. I would keep this as a draft PoC until that defect is fixed.

## Follow-up fixes on 2026-09-29

The findings below describe commit `68d9144`. The follow-up implements these changes:

- Syntax-based import detection replaces the relative-import regular expression. Bare relative barrel imports preserve effects. Named relative imports still remove unused exports. Unsupported relative leaf imports fail with a diagnostic.
- Seventeen projection tests cover runtime effects, commented import syntax, supported relative barrel paths and rejected leaf paths. The independent diagnostic now passes the relative-effect case. Its unreachable-component case still fails.
- All eleven real Next cases pass locally, including two new relative-effect cases. All three Bazel test targets pass under the pinned Node toolchain. Workflow lint and the five scheduling tests also pass.
- The ordinary CI job no longer invokes the fresh-cache mutation experiment. A separate workflow checks build-system changes between successive PR heads, runs weekly and supports manual runs. Five scheduling tests cover follow-up PR commits, initial PRs, build inputs and missing history.
- CI restores full type checks for `web`, `docs` and `@repo/ui` against original sources. These currently run through pnpm independently of Bazel, so their results are not yet Bazel-cached. Local checks pass for all three packages.

The [follow-up Linux CI run](https://github.com/ernest-oneteam/bobr/actions/runs/36555048582) passed Bazel builds, all three test targets and full application type checks. It restored the cache saved by `68d9144` and reported 267 disk-cache hits during the build. This is evidence of reuse across commits on separate CI runners through the Actions archive. It does not prove HTTP remote caching, macOS-to-Linux artifact portability or deployment reuse.

GitHub's built-in PR path filters use the entire PR diff, which would keep triggering the experiment after a build-system change earlier in the same PR. The new detector compares the event's previous and current heads instead. See [GitHub's diff rules](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#git-diff-comparisons).

Unreachable-component traversal, Playwright coverage, remote-cache integration and Vercel artifact deployment remain open. This follow-up does not complete the deployment goals.

## Goal assessment

| Goal                                                       | Assessment                                        | Evidence                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| An unused utility export can change without executing Next | Achieved for the tested import patterns           | Both unused-export cases pass on macOS and Linux                                               |
| Changes to used exports invalidate only affected apps      | Achieved for the current `add` and `sub` fixtures | Linux proof executes only web for `add`, only docs for `sub`                                   |
| Preserve effects and invalidate when they change           | Partial, with a correctness defect                | Barrel fixtures pass; a relative side-effect import loses its effect                           |
| All unreachable shared exports avoid invalidation          | Not achieved                                      | An unreachable component makes an otherwise unused utility enter the projection                |
| Reuse Next despite nondeterministic output                 | Mechanism proved                                  | Next receives identical generated inputs and its stored output survives `bazel clean`          |
| Reuse across consecutive commits on one PR                 | Configured, not proved end to end                 | Actions cache prefixes exist; observed run starts with a cache miss                            |
| Share dev and CI build results through remote caching      | Not integrated                                    | Optional remote configuration exists; CI never selects it and normal package scripts use Nx    |
| Deploy the exact built and tested artifact to Vercel       | Not implemented                                   | Only `.next` is produced; no Vercel packaging/deployment action exists                         |
| No developer-maintained hashes                             | Achieved in the Bazel path                        | Bazel owns action keys; test hashes are assertions only                                        |
| Hands-off source and dependency maintenance                | Partial                                           | Import names are automatic; source aggregation, npm inputs and supported layouts remain manual |
| Preserve existing application checks                       | Not achieved                                      | CI no longer runs Playwright; Next skips app type checking                                     |

## Evidence checked

The [Linux CI run](https://github.com/ernest-oneteam/bobr/actions/runs/36552236479) succeeded. It built `//...`, passed three Bazel test targets and passed all nine real Next mutation cases. Its log reports no initial cache match and saves a cache at the end. This adds Linux evidence to the earlier macOS experiment, but is not evidence of sharing artifacts between those platforms or restoring on a second runner.

I reran the seven projection unit cases with `node --test tools/bazel/project-ui.test.cjs`; all passed. I then added [an independent diagnostic](../scripts/review-ui-projection.cjs) for two omitted cases. Run it with:

```sh
node scripts/review-ui-projection.cjs
```

At the reviewed commit it exits with status 1 and reports both requirements as failing. It creates disposable fixtures and removes them afterward. Its runtime comparison uses esbuild to execute the source and projected modules, not a new Next build. The existing real Next proof was inspected through the successful CI log rather than rerun locally. The installed local `bazel` binary currently fails with `bad CPU type in executable` on this arm64 machine.

## Findings

### 1. A relative side-effect import can silently lose behavior

This is a correctness defect in [project-ui.cjs](../tools/bazel/project-ui.cjs), lines 61 and 91 through 116.

The import scanner recognizes the literal package path `@repo/ui/utils`. A separate regular expression is supposed to reject relative utility imports. That expression handles `from`, `import(...)` and `require(...)`, but misses bare imports:

```ts
// app/page.ts
import { Widget } from "@repo/ui/widget";
export const result = Widget();

// ui/src/widget.tsx
import "./utils";
export const Widget = () => globalThis.__bobrReviewEffect;

// ui/src/utils/index.ts
globalThis.__bobrReviewEffect = 42;
```

The projection accepts this input and emits an empty utility module. The source fixture returns `42`; the projected fixture returns `undefined`. The fixture declares `sideEffects: true`, so an incorrect package annotation does not explain the difference.

Fix the import analysis using the parsed syntax and resolved module paths. Every utility import must either retain its dependency and effects or fail explicitly. Add this case to the normal test suite. The broad claim that effects are preserved is currently too strong.

### 2. Unreachable components broaden every app's dependency set

[project-ui.cjs](../tools/bazel/project-ui.cjs), lines 41 through 45, scans all non-utility UI modules, including components an app never imports. It also copies them all into Next's input tree at lines 102 through 107.

The diagnostic creates an unused component that imports `unused` from the utility barrel. The app imports only `used`. Changing `unused` from `2` to `3` changes the generated utility bundle:

```js
var used = 1;
var unused = 2;
export { unused, used };
var used = 1;
var unused = 3;
export { unused, used };
```

Thus the promised identical intermediate input does not hold for this case. Edits to unused component files also change the copied input tree directly. This is conservative invalidation, not stale output, but limits the performance claim to a subset of utility edits.

A broader guarantee needs traversal from actual app entry points through reachable modules. Next's client/server directives must remain intact. Keep the supported scope explicit until that traversal exists.

### 3. The whole CI workflow still executes Next on every commit

[ci.yml](../.github/workflows/ci.yml), line 57, runs the mutation proof unconditionally. The proof uses a fresh isolated disk cache and expects eight Next executions: two baseline builds, one `add` build, one `sub` build and four effect builds.

This remains true even if the normal app build is entirely cached. In the observed run, the proof takes about 132 seconds of the 209-second workflow. It proves skipping within an experiment while guaranteeing repeated builds across workflow runs.

Keep this regression test, but give it declared fixtures and a cacheable test target, or run it for build-system changes and on a schedule. Measure ordinary PR build actions separately. Do not remove the proof merely to make the timing look better.

### 4. Cross-commit reuse and remote sharing are unfinished

CI archives a local disk cache using GitHub Actions. Its SHA-specific save key has restore prefixes, so the SHA suffix does not inherently prevent reuse. However, the current evidence covers only the first runner and restoration after cleaning outputs at the same checkout path.

The BuildBuddy settings require `--config=remote`, which CI does not pass. `pnpm build` still runs Nx, and `pnpm dev` uses the original source modules. Ordinary local work therefore does not automatically populate the Bazel build cache used by CI.

Prove reuse on a second clean Linux runner, then on consecutive PR commits. A developer's macOS arm64 build and a Linux x64 deployment build can legitimately have different toolchains and keys. Shared caching should promise reuse for compatible actions, not every artifact across every machine. The [deployment research](BAZEL_DEPLOYMENT_RESEARCH.md) cites the relevant Bazel and GitHub documentation.

### 5. Vercel deployment is outside the implemented graph

[The build macro](../tools/bazel/defs.bzl), line 99, produces `.next`. Vercel's prebuilt interface requires `.vercel/output`; no target produces it and no CI step deploys it. There is no association between a cached artifact, an existing preview and the tests already run against that preview. Vercel's two PR checks currently report that authorization is required to deploy.

The projection avoids comparing independently generated Next outputs. That part of the design answers the nondeterminism concern. It does not prove artifact portability, correct Vercel packaging or reuse of an existing deployment.

Build-time environment and fetched content must become declared inputs when introduced. The fixed `bobr-static` ID is not a completed deployment/version policy. See [the sourced deployment analysis](BAZEL_DEPLOYMENT_RESEARCH.md) for the Build Output API and Next configuration requirements.

### 6. The new CI drops application validation

The previous workflow ran Playwright. The Bazel workflow runs two small utility logic tests and the projection tests; it has no Playwright target. Both Next configs set `typescript.ignoreBuildErrors: true`, and the workflow has no complete application type-check target.

A successful Next compilation and the presence of a side-effect string in a browser chunk do not establish that the deployed application behaves correctly. Restore full app type checking and run browser/API tests against the actual artifact intended for deployment. Cache test results separately from runtime build results so a type-only change can rerun type checks without necessarily rebuilding Next.

### 7. Developer hash maintenance is gone, but build maintenance remains

The Bazel path has no manual semantic hashes or lists of imported utility exports. That is a real improvement. Remaining work includes:

- New utility Bazel subpackages must be added to the source aggregation in `packages/ui/src/utils/BUILD.bazel`.
- Next dependency inputs are explicitly listed in `NEXT_BUILD_INPUTS`.
- App sources are limited to `app/**` and `public/**` plus a fixed config list. Common additions such as `components/`, `lib/` or root framework hooks need build-rule changes.
- Direct utility imports and several ordinary dynamic-import patterns are rejected. Package-specific export mappings are hardcoded.
- The package scripts still expose the old Nx and output-hashing workflow alongside Bazel.

This is an effective package-specific experiment, not yet a general monorepo integration. Prefer one documented entry command and generated source/dependency aggregation. For code outside the supported projection, an explicit conservative build path can preserve normal development without promising fine-grained skipping there.

## Acceptance sequence

1. Fix the relative-import defect and add the failing diagnostic cases as requirements. Decide whether unreachable component imports belong in the supported guarantee.
2. Restore full type checks and application tests. Separate the expensive invalidation regression from the ordinary PR build path.
3. Prove a clean Linux runner can retrieve and execute artifacts from the configured shared cache with its local caches empty and the original build directory unavailable.
4. Exercise consecutive commits on one PR. An unused-export edit must execute zero ordinary Next builds. A used-export edit must rebuild only its app. An effect or build-time environment change must rebuild the affected apps.
5. Produce Vercel Build Output under Bazel, deploy that stored output and run tests against the preview. On the next unaffected commit, reuse the artifact and validate the intended deployment-reuse behavior. Evaluate production separately when its build inputs differ.
6. Add a source file and a dependency through the normal developer workflow. Verify that developers do not need to edit hashes or discover missing BUILD-file entries by trial and error.

The remaining work is substantial, but the successful experiment is useful. It establishes that a stable intermediate representation can stop an actual Next build before Next's nondeterministic output becomes relevant. The next step is to make that representation sound and connect it to the real CI and deployment path.
