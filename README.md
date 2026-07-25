# Dux Procurement Portal — Android App (thin shell)

A **one-time, thin Capacitor Android shell** that opens the live Frappe desk page
`https://jewipl.duxdigitech.in/app/dux-indent-portal` full-screen in a WebView.

**No page UI is re-implemented here.** The app is just a window onto the live page.
Every change you make to the page on the server (`dux_indent_portal.js` / `.css` /
`api.py`) appears in the app instantly — **no APK rebuild, no reinstall.** That is
the whole point: the APK is a pointer, the UI lives on the server.

## What the user sees
1. First launch → a **custom DUX login screen bundled in the app** (`www/index.html`),
   NOT the Frappe default login. It authenticates natively against
   `POST /api/method/login` (CapacitorHttp → no CORS, shares the WebView cookie jar).
2. After sign-in → lands directly on the Dux Procurement Portal (the page already hides
   the Frappe desk navbar/sidebar and is fully mobile-responsive).
3. On later launches, if the session cookie is still valid the login screen is skipped
   (checked via `get_logged_user`) and the portal opens straight away.
   (Online-only by design — needs connectivity.)
   Caveat: if the session expires while inside the portal, Frappe may briefly show its
   own `/login`; re-launching the app returns to the DUX login.

## Config that makes this work (capacitor.config.json)
- NO `server.url` → the app boots the local bundled login page.
- `plugins.CapacitorHttp.enabled: true` → login fetch goes native, bypasses CORS,
  and the session cookie lands in the shared WebView cookie jar.
- `server.allowNavigation: ["jewipl.duxdigitech.in"]` → navigating to the portal stays
  inside the app (not kicked to the external browser).
- ZERO server changes — the whole login is client-side in the APK.

## The deliverable
- Signed release APK: `dist/Dux-Procurement-Portal-v1.0.2.apk` (also in Downloads)
- Package id: `com.dux.indentportal`  ·  Version: 1.0.2 (versionCode 3)
- Min Android 6.0 (SDK 23) · Targets Android 15 (SDK 35)
- Android 15 edge-to-edge disabled in `android/app/src/main/res/values/styles.xml`
  (`windowOptOutEdgeToEdgeEnforcement`) so system bars don't overlap the WebView.

## Install (sideload)
Copy the APK to the phone → tap it → allow "Install unknown apps" for the file
manager/browser → Install. (No Play Store needed.)

## 🔑 Keystore — DO NOT LOSE THIS
The release keystore signs the app. To ship any **update to the same app**, you
MUST reuse the exact same keystore + passwords. If lost, users must uninstall the
old app to install a new one (different signature).

- File: `dux-indent-portal.keystore` (project root) — **git-ignored, kept private**
- Alias: `duxindent`
- Store / key password: kept in `android/keystore.properties` — **git-ignored**, not in
  this repo. Ask the project owner for the keystore + password to sign updates.
- Config for Gradle: `android/keystore.properties` (git-ignored)

Back up `dux-indent-portal.keystore` + its password somewhere safe (NOT in git).
Losing them means you cannot ship an update to the same app id.

## Rebuild the APK (only needed to change app name/icon/id/version — NOT for page changes)
Prereqs already on this machine: Node 24, Android SDK, JDK 21 (Android Studio JBR).

```bash
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
cd "/c/Users/HP/dux-indent-app"
# if you changed capacitor.config.json (name/url) or www:
npx cap sync android
# to change icon: edit gen-icons.js, then:
#   node gen-icons.js && npx @capacitor/assets generate --android
cd android
./gradlew assembleRelease
# output: android/app/build/outputs/apk/release/app-release.apk
```

To release an update, bump `versionCode` (and `versionName`) in
`android/app/build.gradle`, rebuild, and distribute the new APK.

## Change what the app points at
Edit `server.url` in `capacitor.config.json`, then `npx cap sync android` and
rebuild. (Currently `https://jewipl.duxdigitech.in/app/dux-indent-portal`.)

## Project layout
- `capacitor.config.json` — app id, name, and the live URL it loads
- `www/index.html` — branded loading/splash placeholder (shown only pre-connect)
- `gen-icons.js` + `assets/` — DUX "DUX" monogram icon on the iris→cyan gradient
- `android/` — generated native project (Gradle)
- `_source/` — reference copy of the live page (js/css/json) + backend (read-only)
- `dist/` — the built APK
