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
- `publishConfig.provenance: true` in `package.json` makes every publish
  include the provenance attestation.

## Cutting a release

```bash
# 1. Decide the bump and update package.json + create the git tag.
npm version patch      # 0.1.0 -> 0.1.1
# or: npm version minor # 0.1.0 -> 0.2.0
# or: npm version major # 0.1.0 -> 1.0.0

# 2. Push the new commit and the tag.
git push --follow-tags

# 3. Create a GitHub Release for that tag. The publish workflow fires on
#    release: published.
gh release create "v$(node -p "require('./package.json').version")" \
  --title "v$(node -p "require('./package.json').version")" \
  --generate-notes
```

That's it. The workflow will:

1. Check out the tag.
2. Install dependencies with `npm ci`.
3. Build (`npm run build`).
4. Run tests (`npm test`).
5. Verify `package.json` version matches the release tag.
6. Publish with `npm publish --provenance --access public`.

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

## Rollback

`npm unpublish agentpack-cli@<version>` is allowed only within 72 hours of
publish, and only if no other package depends on it. Prefer publishing a
new patch version with the fix.

Deprecation (recommended when a version has a bug but unpublish is closed):

```bash
npm deprecate agentpack-cli@<version> "Use <newer-version>: <reason>"
```
