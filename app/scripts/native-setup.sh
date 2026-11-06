#!/bin/bash
# Native iPhone settings that Capacitor doesn't set for us. Safe to run again and again.
set -euo pipefail
cd "$(dirname "$0")/.."
PLIST="ios/App/App/Info.plist"
PB=/usr/libexec/PlistBuddy
setkey() { $PB -c "Set :$1 $3" "$PLIST" 2>/dev/null || $PB -c "Add :$1 $2 $3" "$PLIST"; }
setkey CFBundleDisplayName string "Grindboard"
setkey NSCameraUsageDescription string "Grindboard uses the camera when you take a proof photo of a finished task."
setkey NSPhotoLibraryUsageDescription string "Grindboard lets you pick photos for your journal and proof photos."
setkey NSPhotoLibraryAddUsageDescription string "Grindboard can save your weekly summary image to Photos."
setkey ITSAppUsesNonExemptEncryption bool false
setkey UIUserInterfaceStyle string "Automatic"
# App icon (single 1024x1024 icon, iOS makes the other sizes)
ICONSET="ios/App/App/Assets.xcassets/AppIcon.appiconset"
rm -f "$ICONSET"/*.png
cp resources/icon-1024.png "$ICONSET/AppIcon-1024.png"
cat > "$ICONSET/Contents.json" <<'JSON'
{ "images": [ { "filename": "AppIcon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024" } ], "info": { "author": "xcode", "version": 1 } }
JSON
# Launch screen image
SPLASH="ios/App/App/Assets.xcassets/Splash.imageset"
if [ -d "$SPLASH" ]; then
  rm -f "$SPLASH"/*.png
  for n in splash-2732x2732.png splash-2732x2732-1.png splash-2732x2732-2.png; do cp resources/splash-2732.png "$SPLASH/$n"; done
  cat > "$SPLASH/Contents.json" <<'JSON'
{ "images": [ { "idiom": "universal", "filename": "splash-2732x2732-2.png", "scale": "1x" }, { "idiom": "universal", "filename": "splash-2732x2732-1.png", "scale": "2x" }, { "idiom": "universal", "filename": "splash-2732x2732.png", "scale": "3x" } ], "info": { "version": 1, "author": "xcode" } }
JSON
fi
echo "native setup done"
