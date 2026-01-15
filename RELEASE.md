# Release Process

## Quick Release Guide

### 1. Update Version

Version is automatically synced in:
- `package.json` → version
- `src-tauri/tauri.conf.json` → version

Update both to your new version (e.g., `0.2.0`).

### 2. Build Locally (Optional Test)

```bash
# Build for macOS
npm run build:macos

# The DMG will be in:
# src-tauri/target/release/bundle/dmg/
```

### 3. Create and Push a Git Tag

```bash
# Commit your changes
git add .
git commit -m "Release v0.2.0"

# Create a tag
git tag v0.2.0

# Push commits and tag
git push origin main
git push origin v0.2.0
```

### 4. Automated Build & Release

The GitHub Actions workflow (`.github/workflows/release.yml`) will:
- Build the macOS universal binary (Intel + Apple Silicon)
- Create a DMG installer
- Create a draft GitHub release
- Attach the DMG to the release

### 5. Publish the Release

1. Go to your GitHub repository
2. Click on "Releases"
3. Find the draft release
4. Edit the release notes if needed
5. Click "Publish release"

Users can then download the DMG from the releases page!

## Manual Build

If you need to build manually:

```bash
# Install dependencies
npm install

# Prepare FFmpeg and WebP binaries
npm run prepare:resources

# Build for macOS
npm run build:macos
```

The DMG will be located at:
```
src-tauri/target/release/bundle/dmg/Shift_0.2.0_universal.dmg
```

## Updating the App

To release a new version:

1. Update version in `package.json` and `src-tauri/tauri.conf.json`
2. Commit changes
3. Create and push a new tag: `git tag v0.X.0 && git push origin v0.X.0`
4. GitHub Actions will handle the rest!

## System Requirements

**For Building:**
- Node.js (LTS)
- Rust (stable)
- macOS (for macOS builds)
- FFmpeg and WebP (installed via Homebrew)

**For Users:**
- macOS 10.15 or later
- No additional dependencies needed (FFmpeg is bundled)
