#!/bin/bash

# Script to download and bundle FFmpeg for macOS (ARM64 only)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOURCES_DIR="$SCRIPT_DIR/resources"
FFMPEG_DIR="$RESOURCES_DIR/ffmpeg"

mkdir -p "$FFMPEG_DIR"

echo "Downloading FFmpeg for macOS (ARM64)..."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script is designed for macOS only"
  exit 1
fi

if [[ -x "$FFMPEG_DIR/ffmpeg" ]]; then
  # Verify it's ARM64
  actual_arch=$(file "$FFMPEG_DIR/ffmpeg" | grep -o "arm64" | head -1)
  if [[ "$actual_arch" == "arm64" ]]; then
    echo "FFmpeg already present at $FFMPEG_DIR/ffmpeg (arm64)"
    exit 0
  else
    echo "Removing incorrect architecture binary"
    rm "$FFMPEG_DIR/ffmpeg"
  fi
fi

ARM64_URL="https://www.osxexperts.net/ffmpeg7arm.zip"

echo "Downloading from $ARM64_URL..."

tmp_dir="$(mktemp -d)"
archive_path="$tmp_dir/ffmpeg.zip"

curl -L "$ARM64_URL" -o "$archive_path"
unzip -o "$archive_path" -d "$tmp_dir" >/dev/null 2>&1

ffmpeg_path="$(find "$tmp_dir" -type f -name "ffmpeg" -o -name "ffmpeg7" | head -n 1)"

if [[ -z "$ffmpeg_path" ]]; then
  echo "Failed to locate ffmpeg in archive"
  rm -rf "$tmp_dir"
  exit 1
fi

mv "$ffmpeg_path" "$FFMPEG_DIR/ffmpeg"
chmod +x "$FFMPEG_DIR/ffmpeg"

# Verify architecture
downloaded_arch=$(file "$FFMPEG_DIR/ffmpeg" | grep -o "arm64" | head -1)
echo "Downloaded FFmpeg for $downloaded_arch"

rm -rf "$tmp_dir"

echo "FFmpeg installed to $FFMPEG_DIR/ffmpeg"
