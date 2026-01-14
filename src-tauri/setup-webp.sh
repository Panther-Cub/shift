#!/bin/bash

# Script to download and bundle WebP tools for macOS (ARM64 only)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOURCES_DIR="$SCRIPT_DIR/resources"
WEBP_DIR="$RESOURCES_DIR/webp"

mkdir -p "$WEBP_DIR"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script is designed for macOS only"
  exit 1
fi

echo "Downloading WebP tools for ARM64..."

if [[ -x "$WEBP_DIR/webpmux" && -x "$WEBP_DIR/dwebp" ]]; then
  echo "WebP tools already present at $WEBP_DIR"
  exit 0
fi

VERSION="1.3.2"
url="https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-${VERSION}-mac-arm64.tar.gz"

tmp_dir="$(mktemp -d)"
curl -L "$url" -o "$tmp_dir/webp.tar.gz"
tar -xzf "$tmp_dir/webp.tar.gz" -C "$tmp_dir"

extracted_dir="$(find "$tmp_dir" -maxdepth 1 -type d -name "libwebp-*")"
if [[ -z "$extracted_dir" ]]; then
  echo "Failed to locate extracted WebP directory"
  exit 1
fi

cp "$extracted_dir/bin/webpmux" "$WEBP_DIR/webpmux"
cp "$extracted_dir/bin/dwebp" "$WEBP_DIR/dwebp"
chmod +x "$WEBP_DIR/webpmux" "$WEBP_DIR/dwebp"
rm -rf "$tmp_dir"

echo "WebP tools installed to $WEBP_DIR"
