#!/usr/bin/env bash
# Claudemon.app 빌드 + 설치.
#
# 왜 번들인가: macOS 는 알림의 발신 앱 이름과 좌측 아이콘을 "배너를 올린 앱 번들"
# 에서 가져온다. 맨 실행파일로는 그 신원이 없어서 kitty 가 대신 발신자로 찍혔다.
#
# 왜 ~/Applications 인가 (실측, macOS 26):
#   /private/tmp 등 임시 위치의 번들은 UNUserNotificationCenter 가 통째로 거부한다
#   — requestAuthorization 이 권한 다이얼로그조차 띄우지 않고 UNErrorDomain Code=1
#   로 즉시 실패한다. 레포 안(menubar/)에서 직접 실행하는 것도 같은 이유로 못 쓴다.
#
# 첫 실행에서는 권한 다이얼로그가 뜬다. 허용을 눌러도 그 실행의
# requestAuthorization 콜백은 실패로 반환된다 (앱 쪽 notifyAuthStatus 주석 참고).
# 권한 자체는 기록되므로 다음 실행부터 정상 동작한다.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Claudemon"
INSTALL_DIR="${CLAUDEMON_INSTALL_DIR:-$HOME/Applications}"
APP="$INSTALL_DIR/$APP_NAME.app"
BUNDLE_ID="com.muo.claudemon"

echo "레포:   $REPO_ROOT"
echo "설치처: $APP"

if [[ "$INSTALL_DIR" == /tmp/* || "$INSTALL_DIR" == /private/tmp/* ]]; then
  echo "임시 디렉터리에는 설치할 수 없다 — UN 이 알림을 거부한다: $INSTALL_DIR" >&2
  exit 1
fi

echo "==> 아이콘 생성"
python3 "$REPO_ROOT/scripts/make-app-icon.py" \
  "$REPO_ROOT/sprites/packs/guilmon/idle-0.png" \
  "$REPO_ROOT/menubar/$APP_NAME.icns"

echo "==> 컴파일"
BIN="$(mktemp -t claudemon-menubar)"
swiftc -O -o "$BIN" "$REPO_ROOT/menubar/claudemon-menubar.swift"

echo "==> 번들 조립"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv "$BIN" "$APP/Contents/MacOS/claudemon-menubar"
chmod +x "$APP/Contents/MacOS/claudemon-menubar"
cp "$REPO_ROOT/menubar/$APP_NAME.icns" "$APP/Contents/Resources/$APP_NAME.icns"

# CFBundleVersion 과 NSPrincipalClass 가 없으면 UN 이 앱을 거부한다 (실측).
# LSUIElement 는 Dock 아이콘 없는 메뉴바 상주 앱 — 코드의 setActivationPolicy(.accessory)
# 와 같은 의도지만, 번들 단계에서 선언해야 실행 초기 깜빡임이 없다.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>ko</string>
  <key>CFBundleExecutable</key><string>claudemon-menubar</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIconFile</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST

echo "==> 서명 + 등록"
# 서명 자격이 없어도 ad-hoc(-) 로 충분하다 — 실측으로 UN 알림이 정상 발송된다.
codesign --force --sign - "$APP"
xattr -cr "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"

echo
echo "완료: $APP"
echo
echo "launchd 를 이 번들로 돌리려면 plist 의 ProgramArguments 를 아래로 바꾼다:"
echo "  $APP/Contents/MacOS/claudemon-menubar"
echo "  $REPO_ROOT/sprites"
echo "그리고 EnvironmentVariables 에 CLAUDEMON_PROJECT_ROOT=$REPO_ROOT 를 넣는다"
echo "(번들에서는 실행파일 위치로 레포를 역산할 수 없다)."
echo "인자를 바꿨으므로 kickstart 로는 부족하다:"
echo "  launchctl bootout gui/\$(id -u)/com.muo.claudemon-menubar"
echo "  launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.muo.claudemon-menubar.plist"
