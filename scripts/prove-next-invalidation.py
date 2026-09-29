#!/usr/bin/env python3
"""Exercise real Next actions in a disposable copy of the working tree."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
APPS = {"web", "docs"}


def digest_tree(directory):
    assert directory.is_dir(), f"Missing artifact: {directory}"
    digest = hashlib.sha256()
    for file in sorted(directory.rglob("*")):
        if file.is_file():
            digest.update(str(file.relative_to(directory)).encode() + b"\0")
            digest.update(file.read_bytes())
    return digest.hexdigest()


def actions(file):
    remaining = file.read_text().strip()
    decoder = json.JSONDecoder()
    while remaining:
        action, end = decoder.raw_decode(remaining)
        yield action
        remaining = remaining[end:].lstrip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bazel", default="bazel")
    parser.add_argument("--output-user-root")
    parser.add_argument("--directory", help="New directory for the copy, cache and evidence")
    args = parser.parse_args()
    base = Path(args.directory).resolve() if args.directory else Path(tempfile.mkdtemp(prefix="bobr-next-proof-"))
    checkout = base / "source"
    checkout.mkdir(parents=True, exist_ok=False)
    files = subprocess.check_output(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=ROOT).decode().split("\0")
    for name in set(files):
        source = ROOT / name
        if name and source.is_file():
            target = checkout / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
    command = [args.bazel]
    if args.output_user_root:
        command.append(f"--output_user_root={Path(args.output_user_root).resolve()}")
    flags = ["--lockfile_mode=off", f"--disk_cache={base / 'cache'}", f"--symlink_prefix={base / 'links'}/", "--color=no"]
    results = []
    previous = None
    print(f"Evidence: {base}", flush=True)

    def run(case, expected, projection_changed=None, cache_hits=None):
        nonlocal previous
        logfile = base / f"{case}.log"
        execution = base / f"{case}.actions.json"
        with logfile.open("w") as output:
            result = subprocess.run(command + ["build", "//apps/web:next_build", "//apps/docs:next_build", "//apps/web:ui_projection", "//apps/docs:ui_projection"] + flags + [f"--execution_log_json_file={execution}"], cwd=checkout, stdout=output, stderr=subprocess.STDOUT)
        if result.returncode:
            raise AssertionError(f"{case} failed. See {logfile}\n{logfile.read_text()[-8000:]}")
        recorded = list(actions(execution))
        next_actions = [a for a in recorded if a.get("mnemonic") == "NextBuild"]
        projected = {a["targetLabel"].split("/")[3].split(":")[0] for a in recorded
                     if a.get("mnemonic") == "UiProjection" and not a.get("cacheHit")}
        expected_projection = set() if case in {"no-op", "restore-from-disk-cache"} else APPS
        assert projected == expected_projection, f"{case}: projection executed {projected}, expected {expected_projection}"
        executed = {a["targetLabel"].split("/")[3].split(":")[0] for a in next_actions if not a.get("cacheHit")}
        hits = {a["targetLabel"].split("/")[3].split(":")[0] for a in next_actions if a.get("cacheHit")}
        assert executed == expected, f"{case}: Next executed {executed}, expected {expected}"
        if cache_hits is not None:
            assert hits == cache_hits, f"{case}: cache hits {hits}, expected {cache_hits}"
        for action in next_actions:
            raw = [i["path"] for i in action["inputs"] if "packages/ui/" in i["path"] or "@repo+ui@" in i["path"]]
            assert not raw, f"Raw UI sources leaked into Next inputs: {raw}"
        current = {app: {kind: digest_tree(base / 'links/bin/apps' / app / directory) for kind, directory in [("projection", "ui_runtime"), ("next", ".next")]} for app in APPS}
        if previous is not None:
            changed = {app for app in APPS if current[app]["projection"] != previous[app]["projection"]}
            assert changed == projection_changed, f"{case}: changed projections {changed}, expected {projection_changed}"
            for app in APPS - expected:
                assert current[app]["next"] == previous[app]["next"], f"{case}: cached Next output changed for {app}"
        previous = current
        results.append({"case": case, "projection_executed": sorted(projected), "next_executed": sorted(executed), "next_cache_hits": sorted(hits), "digests": current})
        (base / "results.json").write_text(json.dumps(results, indent=2) + "\n")
        print(f"PASS {case}: Next executed {sorted(executed)}; cache hits {sorted(hits)}", flush=True)

    utils = checkout / "packages/ui/src/utils"
    barrel = utils / "index.ts"
    add = utils / "add/index.ts"
    sub = utils / "sub/index.ts"
    original_barrel = barrel.read_text()
    original_add = add.read_text()
    original_sub = sub.read_text()
    # Existing barrel branch, unused by either app. No BUILD-file maintenance.
    unused = utils / "unused.ts"
    unused.write_text("export const unused = () => 101;\n")
    barrel.write_text(original_barrel + '\nexport { unused } from "./unused";\n')
    run("baseline", APPS)
    run("no-op", set(), set())
    unused.write_text("export const unused = () => 202;\n")
    run("unused-barrel-export", set(), set())
    add.write_text(original_add + "\nexport const unusedSibling = () => 303;\n")
    run("unused-export-in-used-module", set(), set())
    add.write_text(original_add.replace("a + 12", "a + 13"))
    assert add.read_text() != original_add, "Update the fixture replacement for add"
    run("used-add", {"web"}, {"web"})
    sub.write_text(original_sub.replace("a - 5", "a - 6"))
    assert sub.read_text() != original_sub, "Update the fixture replacement for sub"
    run("used-sub", {"docs"}, {"docs"})
    unused.write_text('globalThis.__bobr_side_effect__ = "effect-one";\nexport const unused = () => 202;\n')
    run("side-effect-in-unused-branch", APPS, APPS)
    unused.write_text(unused.read_text().replace("effect-one", "effect-two"))
    run("changed-side-effect", APPS, APPS)
    for app in APPS:
        projection = base / "links/bin/apps" / app / "ui_runtime/utils/index.js"
        assert "effect-two" in projection.read_text()
        chunks = base / "links/bin/apps" / app / ".next/static/chunks"
        assert any("effect-two" in f.read_text() for f in chunks.rglob("*.js")), f"{app}: Next dropped the side effect"
    # Remove Bazel's local outputs/action cache. The disk CAS must restore Next.
    subprocess.run(command + ["clean", "--color=no"], cwd=checkout, check=True, stdout=subprocess.DEVNULL)
    run("restore-from-disk-cache", set(), set(), APPS)
    print(f"All cases passed. Full action logs and digests: {base / 'results.json'}", flush=True)


if __name__ == "__main__":
    main()
