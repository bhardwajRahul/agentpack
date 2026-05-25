# Releasing Agentpack

Agentpack publishes to npm as `agentpack-cli` from GitHub Actions, signed with
npm provenance via a Trusted Publisher. No `NPM_TOKEN` is stored in the repo.

## One-time setup (already done)

- npmjs.com → package `agentpack-cli` → Settings → Trusted Publisher:
  - Repository: `ihorponom/agentpack`
  - Workflow: `publish.yml`
  - Environment: *(empty)*
- `.github/workflows/publish.yml` requests `id-token: write` so it can present
  a short-lived OIDC token that npm verifies against the Trusted Publisher
  binding.
- The publish workflow uses Node 24 so the bundled npm is new enough for
  Trusted Publishing without upgrading npm while npm is running.
- `publishConfig.provenance: true` in `package.json` makes workflow publishes
  include the provenance attestation.

## Cutting a release

Release discipline:

- A normal push to `main` never publishes to npm.
- Keep feature/docs commits separate from the version bump.
- Make the version bump as its own release-prep commit after the feature branch
  has been reviewed and pushed.
- Re-run pre-flight after the version bump, because the package metadata and
  tarball have changed.
- For small patch releases, write concise notes in the GitHub Release. Do not
  add a weak release-notes file to the repo just to have one.
- After a release is published, new commits on `main` are next-release
  candidates. Do not describe unreleased commands or behavior as available in
  the already-published npm version.
- The agent may create the GitHub Release when asked, but the human owner can
  check GitHub Actions and npm status manually. Do not add extra workflow/npm
  polling unless explicitly requested.
- This flow is still too manual; prefer adding a single `release:patch` helper
  later once the exact release contract is stable.

```bash
# 1. After feature/code commits are reviewed and pushed, create a separate release-prep commit for the version bump.
#    Re-run full preflight after the version bump because package metadata and the tarball changed.
#    Docs-only commits after a verified release do not require full preflight; review the diff and run lightweight checks such as `git diff --check`.

npm version patch --no-git-tag-version
VERSION="$(node -p "require('./package.json').version")"

git add package.json package-lock.json
git commit -m "chore(release): prepare ${VERSION}"

# 2. Push the release-prep commit.
git push origin main

# 3. Create and push the tag.
git tag "v${VERSION}"
git push origin "v${VERSION}"

# 4. Create a GitHub Release for that tag. The publish workflow fires on
#    release: published.
gh release create "v${VERSION}" \
  --title "v${VERSION}" \
  --generate-notes
```

That's it. The workflow will:

1. Check out the tag.
2. Install dependencies with `npm ci`.
3. Build (`npm run build`).
4. Run tests (`npm test`).
5. Verify `package.json` version matches the release tag.
6. Publish with `npm publish --access public`.

Watch the run at <https://github.com/ihorponom/agentpack/actions>. When it
finishes, npm shows the green `Provenance` badge on the package page.

## Manual fallback

If a release is published while Actions is disabled, or the publish step
fails, re-run from the Actions tab:

1. GitHub → Actions → "Publish to npm" → Run workflow.
2. Pick the tag (or `main`) and choose `dry-run: true` first to verify.
3. Re-run with `dry-run: false`.

## Pre-flight checklist

Before `npm version`:

- `npm test` is green locally.
- `agentpack doctor` is clean in the repo (warnings about source-cache
  staleness are ok; errors are not).
- `npm pack --dry-run` shows the expected set of files and a reasonable
  tarball size (~85 kB at the time of writing).
- README, CHANGELOG (if any), and docs reflect the version about to ship.
- Changes to install flows, MCP launchers, or generated client config are
  dogfooded in at least one non-Agentpack repo before release. Verify generated
  snippets point at stable package entrypoints, not transient shell shims.
- Do not cut a release while basic install, doctor, MCP startup, or resume flows
  are suspect. Prefer fixing and shipping one follow-up patch over rushing
  multiple releases that churn the same core workflow.

## Rollback

`npm unpublish agentpack-cli@<version>` is allowed only within 72 hours of
publish, and only if no other package depends on it. Prefer publishing a
new patch version with the fix.

Deprecation (recommended when a version has a bug but unpublish is closed):

```bash
npm deprecate agentpack-cli@<version> "Use <newer-version>: <reason>"
```
