# Shift

**The fastest way to convert WebP videos to MP4 on macOS.**

Shift is a native macOS application that makes WebP to MP4 conversion simple and fast. Drag and drop your files, customize quality settings, and batch convert with ease.

![macOS](https://img.shields.io/badge/macOS-ARM64-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

## Download

**[Download Shift v0.1.0 (Apple Silicon)](https://github.com/Panther-Cub/shift/releases/latest)**

Just download the DMG, drag Shift to your Applications folder, and you're ready to go. No dependencies, no setup required.

## Features

- 🚀 **Drag & Drop** - Drop WebP files anywhere in the app
- ⚡ **Batch Processing** - Convert multiple files at once with parallel processing
- 🎨 **Quality Presets** - Choose from High, Balanced, or Small file sizes
- 📊 **Live Progress** - See conversion progress in real-time
- 🎬 **FPS Control** - Keep original framerate or set custom (24/30/60 fps)
- 🌗 **Dark Mode** - Automatically matches macOS system preference
- 📦 **Zero Dependencies** - FFmpeg bundled inside, works offline

## Quick Start

1. **Download** the DMG from [Releases](https://github.com/Panther-Cub/shift/releases)
2. **Install** by dragging Shift.app to Applications
3. **Launch** Shift
4. **Drop** your WebP videos or click "Add Files"
5. **Convert** - Click "Start All" to begin batch conversion

Files are saved to the same location as the source by default, or choose a custom output folder.

## Quality Settings

| Preset | Use Case | CRF | File Size |
|--------|----------|-----|-----------|
| **High** | Archival, professional work | 18 | Largest |
| **Balanced** | General use, web sharing | 23 | Medium |
| **Small** | Quick sharing, storage-limited | 28 | Smallest |

All conversions use H.264 video (libx264) and AAC audio at 192kbps.

## System Requirements

- macOS 11.0 (Big Sur) or later
- Apple Silicon (M1/M2/M3)
- ~50MB disk space

## Building from Source

### Prerequisites

- Node.js 18+
- Rust (stable toolchain)
- macOS development environment

### Build Steps

```bash
# Clone the repository
git clone https://github.com/Panther-Cub/shift.git
cd shift

# Install dependencies
npm install

# Download FFmpeg and WebP tools
cd src-tauri
./setup-ffmpeg.sh
./setup-webp.sh
cd ..

# Build the app
npm run build:macos
```

The DMG will be at `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Shift_0.1.0_aarch64.dmg`

### Development Mode

```bash
npm run tauri dev
```

## Tech Stack

- **Tauri 2.0** - Native macOS app framework
- **React 19** - UI framework
- **TypeScript** - Type safety
- **Tailwind CSS + shadcn/ui** - Modern component library
- **FFmpeg 7** - Video conversion engine (bundled)
- **Rust** - High-performance backend

## Architecture

```
shift/
├── src/                          # React frontend
│   ├── components/ui/            # shadcn/ui components
│   ├── features/converter/       # Main conversion feature
│   │   ├── api/convert.ts       # Tauri API bridge
│   │   └── components/          # Converter UI
│   └── lib/utils.ts             # Utilities
├── src-tauri/                   # Rust backend
│   ├── resources/               # Bundled binaries
│   │   ├── ffmpeg/             # FFmpeg 7 (ARM64)
│   │   └── webp/               # WebP tools
│   └── src/lib.rs              # Conversion logic
└── README.md
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Issues and pull requests are welcome! Please read the contributing guidelines before submitting.

---

Made with ❤️ by [Panther-Cub](https://github.com/Panther-Cub)
