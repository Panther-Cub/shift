# WebP to MP4 Converter

Desktop application for converting WebP videos to high-quality MP4 format.

Built with Tauri, React, TypeScript, and shadcn/ui.

## Status: ✅ Ready for Development

### Completed Setup
- ✅ Tauri + React project scaffolded
- ✅ shadcn/ui components integrated
- ✅ Feature-based architecture implemented
- ✅ FFmpeg bundled for macOS
- ✅ Video converter UI and logic
- ✅ Tailwind CSS configured

### Project Structure

```
webpconv/
├── src/                           # Frontend React app
│   ├── components/ui/             # shadcn/ui components
│   ├── features/converter/        # Converter feature
│   │   ├── api/convert.ts        # Tauri API calls
│   │   └── components/           # UI components
│   ├── lib/utils.ts              # Utilities
│   └── App.tsx                   # Main app
├── src-tauri/                    # Rust backend
│   ├── resources/ffmpeg/         # Bundled FFmpeg
│   └── src/lib.rs               # Conversion logic
└── README.md
```

### Quick Start

```bash
# Development
npm run tauri dev

# Build for production
npm run tauri build
```

### Features

- Drag-and-drop WebP file selection
- High-quality MP4 conversion (H.264, CRF 18)
- Progress tracking
- Automatic output file placement
- Clean, modern macOS-native UI

### Technical Details

**Frontend:**
- React 18 + TypeScript
- Vite for bundling
- Tailwind CSS + shadcn/ui
- Feature-based architecture

**Backend:**
- Tauri 2.0
- Rust for performance
- Bundled FFmpeg (no external deps)

**Conversion Settings:**
- Codec: H.264 (libx264)
- Preset: slow
- CRF: 18 (high quality)
- Audio: AAC @ 192kbps

## Next Steps

The application is ready to run! Use `npm run tauri dev` to test it out.
