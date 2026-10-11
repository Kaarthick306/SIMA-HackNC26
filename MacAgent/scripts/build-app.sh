#!/bin/zsh
# Build the MCP server and the menu bar app, and install MacAgentBar.app into ~/Applications.
set -euo pipefail
ROOT="${0:A:h:h}"

echo "→ Building MCP server"
(cd "$ROOT/backend" && npm install --silent && npx tsc)

echo "→ Building menu bar app"
(cd "$ROOT/menubar" && swift build -c release)
BIN="$(cd "$ROOT/menubar" && swift build -c release --show-bin-path)/MacAgentBar"

APP="$ROOT/build/MacAgentBar.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/MacAgentBar"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MacAgentBar</string>
  <key>CFBundleDisplayName</key><string>Mac Agent</string>
  <key>CFBundleIdentifier</key><string>local.mac-agent.bar</string>
  <key>CFBundleExecutable</key><string>MacAgentBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign --force -s - "$APP"

mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/MacAgentBar.app"
cp -R "$APP" "$HOME/Applications/"
echo "✓ Installed ~/Applications/MacAgentBar.app — open it with: open ~/Applications/MacAgentBar.app"
