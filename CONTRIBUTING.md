# Contributing

Thanks for your interest in DevFlow.

## Setup

```bash
git clone https://github.com/Delaksan-Sritharan/DevFlow.git
cd DevFlow
npm install
npm run build
npm test
```

Requires Node 22 or newer.

## Layout

- `packages/core`: the engine (no VS Code dependency). Most changes belong here.
- `packages/cli`: the `devflow` command.
- `packages/vscode`: the extension. It bundles core with esbuild.
- `examples/demo`: a three-service project that fails if started out of order.

## Guidelines

- Add or update tests in `packages/core/test` for engine changes. `npm test` must pass and `npm run typecheck` must be clean.
- Keep commits small and focused, with [Conventional Commits](https://www.conventionalcommits.org/) subjects
  (`feat(core): ...`, `fix(cli): ...`, `docs: ...`), imperative mood, 50 characters or fewer.
- To try the extension, run `npm run package -w devflow-vscode` and install `packages/vscode/devflow.vsix`.

## Releasing (maintainers)

1. Bump `version` in `packages/vscode/package.json` and add a `CHANGELOG.md` entry.
2. Tag and push: `git tag v0.1.1 && git push --tags`.
3. The `Release` workflow tests, packages, and publishes to the VS Code Marketplace and Open VSX
   (repository secrets `VSCE_PAT` and `OVSX_PAT`).
