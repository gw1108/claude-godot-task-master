Increment the project's build/version number across all files that pin it.

## Version format

The root version follows `1.0.0-rc.N` (a semver release-candidate). The default action is to bump the trailing `rc.N` counter (e.g. `1.0.0-rc.4` → `1.0.0-rc.5`). If the user asks for a different bump (patch/minor/major or a specific version), use that instead.

## Files to change

The version string lives in **two files**, three locations total. All must stay in sync:

1. `package.json` — the root `"version"` field (1 occurrence).
2. `package-lock.json` — **two** occurrences:
   - top-level `"version"` (around line 3)
   - `packages[""].version` (around line 9, the entry for the root workspace)

The workspace packages under `apps/*` and `packages/*` have their own independent versions and are **not** touched by this skill unless the user asks.

## Steps

1. Read the current root version from `package.json`:
   ```bash
   node -p "require('./package.json').version"
   ```
2. Compute the new version (bump `rc.N` by default, or per the user's request).
3. Find every place the old version is pinned to confirm the count before editing:
   ```
   Grep pattern: <old-version-escaped>   (e.g. 1\.0\.0-rc\.4)
   ```
   Expect 1 hit in `package.json` and 2 in `package-lock.json`. If other files show up, ask before changing them.
4. Edit each occurrence with an exact string replace. In `package-lock.json` the two lines are identical (`"version": "<old>",`), so anchor each edit with surrounding context (`"lockfileVersion": 3` for the first, `"license": "MIT WITH Commons-Clause"` for the second) to keep replacements unique.
5. Do **not** run `npm install` just to regenerate the lockfile — editing it directly is faster and avoids dependency churn. (Run `/build` separately if the global `task-master` needs relinking to the new version.)

## Final message

Report the bump in one line, e.g. "Build number incremented: 1.0.0-rc.4 → 1.0.0-rc.5 in package.json and package-lock.json (both root version entries)." Commit only if the user asks.
