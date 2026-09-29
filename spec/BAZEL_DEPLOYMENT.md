# Shared cache and Vercel setup

The Bazel build produces Vercel Build Output API v3 using the locked Vercel CLI.
Browser tests run its function handlers and static files from an isolated copy.
CI archives that same output, and the deployment job calls `vercel deploy
--prebuilt`. Vercel does not run another application build on this path.
See Vercel's [build command](https://vercel.com/docs/cli/build) and
[prebuilt deployment](https://vercel.com/docs/cli/deploy#prebuilt).

## Connect the intended account

The account connected during this evaluation returned no teams or projects.
Reconnect the Vercel integration to the account that owns this project. That
connection lets the assistant inspect projects; GitHub Actions needs its own
credentials below. Do not put tokens in chat or in this repository.

Create or select two Vercel projects for `apps/web` and `apps/docs`. Match their
Node version to the checked-in `vercel-build.json`, currently Node 22. Disable
automatic Vercel Git builds for this branch/repository when enabling the Actions
deployment path, or Vercel's Git integration will still build independently.

Configure these GitHub Actions repository variables and secret on the repository
that runs CI. The fork currently has none configured.

| Setting                  | Kind     | Value                             |
| ------------------------ | -------- | --------------------------------- |
| `VERCEL_ORG_ID`          | Variable | Intended account or team ID       |
| `VERCEL_WEB_PROJECT_ID`  | Variable | Web project ID                    |
| `VERCEL_DOCS_PROJECT_ID` | Variable | Docs project ID                   |
| `VERCEL_TOKEN`           | Secret   | Deployment token for that account |
| `VERCEL_DEPLOY_ENABLED`  | Variable | `1` after the above are ready     |

Pushes to `main` build and deploy production artifacts. The `bazel` branch and
same-repository PRs build previews. Fork PRs build and test without deployment
credentials. GitHub environments are named `preview` and `production`.

The deployment script checks the artifact target and requires Linux x64 with
Node 22. Preview and production are separate Bazel configurations through
`--define=deploy_env=preview` and `--define=deploy_env=production`. A developer's
macOS artifact cannot be uploaded as a Linux production build by this script.

The current apps have no required build-time environment or remote data. Account
linkage happens after the build. If an app starts consuming environment-specific
values or fetched content, declare those inputs before allowing cache reuse.
Changing a Vercel dashboard environment variable alone does not change a Bazel
key. Runtime secrets belong in Vercel, not cached build artifacts.

## Configure the shared cache

Use a Bazel-compatible HTTPS or gRPC TLS cache. The wrapper accepts these values:

| Setting                     | Kind in GitHub    | Purpose                                                                                  |
| --------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `BAZEL_REMOTE_CACHE`        | Variable          | `https://…` or `grpcs://…` endpoint                                                      |
| `BAZEL_REMOTE_READ_HEADER`  | Secret            | Complete header such as `Authorization=Bearer …`, with backend-enforced read-only access |
| `BAZEL_REMOTE_WRITE_HEADER` | Secret            | Complete header for trusted push writers                                                 |
| `BAZEL_REMOTE_PUBLIC_READ`  | Optional variable | `1` only for a deliberately public read endpoint                                         |

CI gives writer credentials to pushes. PRs receive the read credential when
GitHub makes it available; fork PRs receive no secrets. Without credentials or
explicit public-read configuration, CI uses its Actions-backed disk cache.
Read-only access must be enforced by the backend. A command-line flag alone
cannot restrict a credential held by code under test.

Locally, set `BAZEL_REMOTE_CACHE` and `BAZEL_REMOTE_HEADER` in your shell's secret
manager integration. Reads are the default. Set `BAZEL_REMOTE_UPLOAD=1` only with
a writer credential. The wrapper puts credentials in a temporary mode-0600 rc
file and removes it when Bazel exits. It does not print the token or put it in
command arguments. Direct `bazel` calls bypass this wrapper.

Compatible toolchains and inputs can share actions. macOS arm64 and Linux x64
builds have different execution platforms, so do not expect their complete Next
artifacts to share a key. See [Bazel remote caching](https://bazel.build/remote/caching).

## Finish hosted validation

Run the CI workflow after configuring the account and cache. Confirm that both
preview URLs serve the tested pages and API, then exercise consecutive commits
with an unused export, a used export and a side-effect change. Repeat from a
fresh Linux client with the disk cache disabled and inspect remote-cache hits.

The local HTTP experiment proves cache restoration between independent Bazel
clients. It does not prove the selected provider's authentication or eviction
policy. The local artifact tests do not emulate all Vercel routing, protection,
edge features or runtime settings. Production deployment and hosted smoke tests
remain pending until the correct account and projects are available.

An unaffected commit reuses the artifact and browser result. The deployment
job can still create a deployment record for that commit using the same bytes.
It does not currently deduplicate deployment records or reuse an existing URL.
