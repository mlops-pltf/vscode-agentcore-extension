# Releasing AgentCore Chat

Releases are GitHub Releases with the `.vsix` attached, built by `.github/workflows/release.yml` when a version tag is pushed. Releases are made from `main`.

## Versions

- **0.x**: betas for internal testing (marked as pre-release on GitHub). 0.9.0 is the first.
- **1.0.0**: the first customer release, once the office checklists pass (see `docs/IMPLEMENTATION_PLAN.md`, Phase 11).
- After that: a **minor** version per new feature phase (1.1.0, 1.2.0, ...) and a **patch** version for fixes only (1.0.1, ...).

## Making a release

1. **Changelog**: in `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and add a new empty `## [Unreleased]` above it. This section becomes the release notes.
2. **Version**: `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and `package-lock.json`).
3. **Pull request**: commit both on a branch, open a pull request into `main`, wait for CI (lint, Python and JS tests, sample agent tests, packaging check) and merge it.
4. **Tag** the merged `main`:

   ```
   git checkout main
   git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. **Watch** the *Release* workflow on GitHub (Actions tab). It runs CI again, checks the tag matches `package.json`, packages `agentcore-chat-X.Y.Z.vsix` and creates the release. If the tag and version don't match, nothing is published: fix it, delete the tag (`git push origin :refs/tags/vX.Y.Z`, `git tag -d vX.Y.Z`) and tag again.

To check packaging locally first: `npx @vscode/vsce@3 package` (it should finish without warnings).

## Installing a release

1. On the repository's **Releases** page, download `agentcore-chat-X.Y.Z.vsix`.
2. In VS Code: **Extensions** view → `...` menu → **Install from VSIX...**, and pick the file. Or from a terminal: `code --install-extension agentcore-chat-X.Y.Z.vsix`.
3. Reload VS Code when asked. Installing a newer `.vsix` replaces the old version; settings are kept.
