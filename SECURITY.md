# Security Policy

Agentpack is designed as a local-first developer tool. The default threat model assumes task state may contain source paths, command output, stack traces, and implementation notes that should stay on the developer machine.

## v0 Security Commitments

- No telemetry.
- No network calls in normal CLI or MCP operation.
- No dependency install or download during `agentpack install`.
- No `postinstall` script.
- No shell hooks installed silently.
- No source upload or hosted sync.
- No full repository copy in `.agentpack/` by default.
- Runtime package has zero third-party dependencies in v0.

## npm Supply Chain

The project uses a conservative npm setup:

- zero runtime dependencies
- exact dependency versions
- committed lockfile
- `ignore-scripts=true` for installs
- TypeScript compiler is the only build dependency
- the release workflow publishes from GitHub Actions via a Trusted Publisher OIDC binding
- versions published by that workflow ship with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) — no long-lived npm tokens are stored anywhere

## Verifying a release

To verify a downloaded version of `agentpack-cli`:

```bash
npm audit signatures
```

For workflow-published versions, the npmjs.com page for the package also shows a **Provenance** tab linking back to the exact commit, workflow run, and build environment that produced the tarball.

## Maintainer pre-publish checklist

Before cutting a new release, maintainers should run:

```bash
npm ci
npm audit signatures
npm test
npm pack --dry-run
```

The full release flow is documented in [docs/RELEASING.md](docs/RELEASING.md).

## Sensitive Data

Agentpack redacts common secret-looking values and configured environment variable values from generated context and key local records such as source summaries, evidence, checkpoints, replay output, and MCP context responses.

Redaction is best-effort, not a guarantee. Users should treat `.agentpack/` as project-sensitive data and review exported handoff files before sharing them.

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories:

<https://github.com/ihorponom/agentpack/security/advisories/new>

This keeps the report hidden until a fix is ready and gives credit to the reporter. Do not open a regular issue for security problems.
