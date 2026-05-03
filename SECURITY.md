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

- exact dependency versions
- committed lockfile
- `ignore-scripts=true` for installs
- TypeScript compiler only for builds
- npm provenance enabled for future public releases
- trusted publishing preferred over long-lived npm tokens

Before publishing, maintainers should run:

```bash
npm ci
npm audit signatures
npm test
npm pack --dry-run
```

## Sensitive Data

Agentpack redacts common secret-looking values from generated resume context, but redaction is best-effort. Users should treat `.agentpack/` as project-sensitive data and review exported handoff files before sharing them.

## Reporting

Until a public repository security contact exists, report issues privately to the project maintainer.
