#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Nicole"
BUNDLE_ID="com.banjo.nicole"
BUILD_DIR="$SCRIPT_DIR/.build/release"
APP_BUNDLE="/Applications/${APP_NAME}.app"

echo "Building Nicole..."
cd "$SCRIPT_DIR"
swift build -c release 2>&1

BINARY="$BUILD_DIR/NicoleMacOS"

if [ ! -f "$BINARY" ]; then
  echo "Build failed — binary not found at $BINARY"
  exit 1
fi

echo "Packaging ${APP_NAME}.app..."

# Clean old bundle
rm -rf "$APP_BUNDLE"

# Create .app structure
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

# Copy binary
cp "$BINARY" "$APP_BUNDLE/Contents/MacOS/NicoleMacOS"

# Copy Info.plist
cp "$SCRIPT_DIR/Info.plist" "$APP_BUNDLE/Contents/Info.plist"

# Copy icon
if [ -f "$SCRIPT_DIR/AppIcon.icns" ]; then
  cp "$SCRIPT_DIR/AppIcon.icns" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
fi

# Sign with local "Nicole Dev" certificate (stable identity across rebuilds)
# This keeps macOS permissions (screen recording, accessibility) intact
codesign --force --deep --sign "Nicole Dev" \
  --entitlements "$SCRIPT_DIR/Nicole.entitlements" \
  "$APP_BUNDLE"

echo ""
echo "Done! Nicole.app installed to /Applications/"
echo ""
echo "First run:"
echo "  1. Open /Applications/Nicole.app"
echo "  2. macOS will prompt for Screen Recording — grant it"
echo "  3. macOS will prompt for Accessibility — grant it"
echo "  4. Permission sticks across rebuilds (same bundle ID)"
echo ""
echo "To rebuild after code changes, just run this script again."
