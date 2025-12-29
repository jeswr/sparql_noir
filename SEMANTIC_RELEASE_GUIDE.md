# Semantic Release Quick Reference

This repository uses [semantic-release](https://semantic-release.gitbook.io/) for automated version management and package publishing.

## How It Works

1. **Commit with conventional format** → Determines release type
2. **Push to main/master** → Triggers automated release
3. **Semantic-release analyzes commits** → Calculates new version
4. **Automated release** → Publishes to npm and GitHub

## Commit Message Format

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

### Types and Their Impact

| Type | Description | Release |
|------|-------------|---------|
| `feat` | New feature | **Minor** (0.x.0) |
| `fix` | Bug fix | **Patch** (0.0.x) |
| `perf` | Performance improvement | **Patch** (0.0.x) |
| `docs` | Documentation only | **Patch** (0.0.x) |
| `style` | Code style changes | **Patch** (0.0.x) |
| `refactor` | Code refactoring | **Patch** (0.0.x) |
| `test` | Test changes | **Patch** (0.0.x) |
| `build` | Build system changes | **Patch** (0.0.x) |
| `ci` | CI configuration | **Patch** (0.0.x) |
| `chore` | Other changes | **Patch** (0.0.x) |
| `BREAKING CHANGE` | Breaking change | **Major** (x.0.0) |

### Examples

#### Feature (Minor Release)
```bash
git commit -m "feat: add SPARQL UNION support"
```
Result: 1.0.0 → 1.1.0

#### Bug Fix (Patch Release)
```bash
git commit -m "fix: correct blank node encoding"
```
Result: 1.1.0 → 1.1.1

#### Breaking Change (Major Release)
```bash
git commit -m "feat!: change sign() API signature

BREAKING CHANGE: sign() now requires config parameter"
```
Result: 1.1.1 → 2.0.0

#### Documentation (Patch Release)
```bash
git commit -m "docs: add API usage examples"
```
Result: 2.0.0 → 2.0.1

#### Multiple Changes
```bash
git commit -m "feat: add OPTIONAL pattern support

Also includes:
- fix: correct FILTER variable binding
- docs: update SPARQL coverage documentation

Closes #123"
```
Result: Minor release (feature takes precedence)

## Release Workflow

### Automatic Release (Recommended)

1. **Make your changes**
   ```bash
   git checkout -b feature/my-feature
   # make changes
   ```

2. **Commit with conventional format**
   ```bash
   git add .
   git commit -m "feat: add my feature"
   ```

3. **Push and create PR**
   ```bash
   git push origin feature/my-feature
   # Create PR on GitHub
   ```

4. **Merge to main**
   - Once PR is approved and merged
   - GitHub Actions automatically runs semantic-release
   - New version is published to npm

### Manual Release (Not Recommended)

If you need to trigger a release manually:

```bash
npm run semantic-release
```

Note: This requires NPM_TOKEN environment variable.

## What Gets Released

On each release, semantic-release will:

1. ✅ Analyze commit messages since last release
2. ✅ Determine new version number
3. ✅ Generate CHANGELOG.md
4. ✅ Update version in package.json
5. ✅ Build the package (`npm run build:tsc`)
6. ✅ Publish to npm registry
7. ✅ Create Git tag
8. ✅ Create GitHub release with notes
9. ✅ Commit changelog and version bump

## Branch Configuration

Releases are triggered only from these branches:
- `main`
- `master`

Feature branches will NOT trigger releases.

## Versioning Strategy

This project uses **Semantic Versioning (SemVer)**:

```
MAJOR.MINOR.PATCH

Example: 2.3.5
         │ │ └─ Patch: Bug fixes, docs
         │ └─── Minor: New features (backwards compatible)
         └───── Major: Breaking changes
```

### Pre-releases

For pre-release versions, create a branch with the pre-release name:

```bash
git checkout -b beta
git commit -m "feat: new experimental feature"
git push origin beta
```

This creates versions like: `1.2.0-beta.1`, `1.2.0-beta.2`, etc.

## Configuration Files

- `.releaserc.json` - Semantic-release configuration
- `.github/workflows/release.yml` - GitHub Actions workflow
- `package.json` - Version and package metadata

## Common Scenarios

### Scenario 1: Bug Fix

```bash
git checkout -b fix/issue-123
# Fix the bug
git commit -m "fix: resolve memory leak in prove function

Fixes #123"
git push origin fix/issue-123
# Create PR, merge to main
# Result: Patch release (e.g., 1.2.3 → 1.2.4)
```

### Scenario 2: New Feature

```bash
git checkout -b feature/optional-support
# Implement feature
git commit -m "feat: add SPARQL OPTIONAL pattern support

Implements full OPTIONAL semantics as per SPARQL 1.0 spec"
git push origin feature/optional-support
# Create PR, merge to main
# Result: Minor release (e.g., 1.2.4 → 1.3.0)
```

### Scenario 3: Breaking Change

```bash
git checkout -b breaking/api-redesign
# Make breaking changes
git commit -m "feat!: redesign prove API for better ergonomics

BREAKING CHANGE: prove() now takes options object instead of positional parameters

Before: prove(query, circuit, data)
After: prove({ query, circuit, data })"
git push origin breaking/api-redesign
# Create PR, merge to main
# Result: Major release (e.g., 1.3.0 → 2.0.0)
```

## Troubleshooting

### No Release Created

Possible reasons:
1. **No releasable commits** - Only chore/ci commits since last release
2. **Wrong branch** - Pushed to feature branch instead of main
3. **Missing NPM_TOKEN** - Check GitHub repository secrets

### Release Failed

Check the GitHub Actions logs:
1. Go to repository → Actions tab
2. Click on the failed workflow run
3. Check the semantic-release step for errors

Common issues:
- **Authentication failed** - NPM_TOKEN is invalid or expired
- **Build failed** - TypeScript compilation errors
- **Version conflict** - Manual version changes in package.json

### Skip Release

To commit without triggering a release, add `[skip ci]` to commit message:

```bash
git commit -m "chore: update dev dependencies [skip ci]"
```

## Resources

- [Semantic Release Documentation](https://semantic-release.gitbook.io/)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [SemVer Specification](https://semver.org/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)

## Summary

1. ✅ Use conventional commit messages
2. ✅ Merge to main to trigger release
3. ✅ Semantic-release handles everything automatically
4. ✅ Check GitHub Actions for release status
5. ✅ Package published to npm and GitHub

Questions? Check the [API_IMPLEMENTATION.md](./API_IMPLEMENTATION.md) for more details.
