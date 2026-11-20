# artipeek for iOS

A native SwiftUI shell around artipeek's own web UI, plus push notifications for decisions. The app shows the artipeek
server in a `WKWebView`, so the Decisions tab, the file list, file tabs, answers and explainers are the web version's,
and a new web feature is in the app without an app update.

Native parts:

- **Login**: the Cloudflare Access login page shows inside the app. The login (cookie `CF_Authorization`) is kept in the
  persistent website data store until it runs out; then the login page shows again.
- **Push**: after login, the app asks for permission once and registers its device token with the server
  (`POST /_/push/register`, sent from the web view, so it carries the page's login). A push for a decision that is
  raised, or turns urgent; a tap opens that decision. The badge is the number of open decisions (set by each push, and
  when the app opens). See "iOS app and push" in the main README for the server side.
- **Settings**: the gear in artipeek's header (the file list, or the home page), or the round gear on the login page:
  server, notifications on/off, a test push, sign out.
- Like Safari for artipeek: inline scripts with the page's nonce, live updates (EventSource), sandboxed HTML frames, the
  answer sheet, downloads (to the share sheet), pull to refresh, dark mode. Links to other sites open in a Safari
  sheet; same-site new windows (e.g. "raw") in a sheet of their own.

No analytics, no third-party code.

## Build

Needs Xcode 26 (iOS 17 or later on the phone), [XcodeGen](https://github.com/yonaskolb/XcodeGen) and
[fastlane](https://fastlane.tools) (`brew install xcodegen fastlane`).

1. `cp Config/Local.xcconfig.example Config/Local.xcconfig` and set your team id, bundle id and server host.
   This file is gitignored; it is the only place they live (fastlane reads them from it).
2. `cp fastlane/.env.example fastlane/.env` and set an App Store Connect API key (Admin role, for cloud signing).
3. `xcodegen generate` makes `Artipeek.xcodeproj` (not tracked; fastlane regenerates it before every build).
4. The server: `push.apns` in artipeek's config, with an APNs key of the same team (see the main README).

The app icon is artipeek's `assets/icon.svg`: `scripts/make-icon.sh` renders it.

## fastlane lanes (run in `ios/`)

| Lane | What it does |
|---|---|
| `fastlane beta` | TestFlight: checks the App Store Connect app exists, regenerates the project, build number = latest TestFlight build + 1, archives and exports with automatic cloud signing, uploads. `changelog:"…"` sets What to Test (and waits for processing). |
| `fastlane device` | Development build installed and started on an iPhone over the network (`xcrun devicectl`; `device_name:"…"` or `device_id:"…"`). It registers as a `sandbox` push token. |
| `fastlane test` | Unit tests on a simulator. |
| `fastlane testers` | Makes sure the app's internal TestFlight group exists (every build) and adds `TESTFLIGHT_TESTERS` from `fastlane/.env`. Apple refuses the API for someone who is already an email-invited tester of another app: then add them once in App Store Connect (TestFlight → Internal → Testers → +). `beta` runs it when the variable is set. |
| `fastlane app_id` | Registers the bundle id with Push Notifications in the developer portal, if missing. |
| `fastlane app_record` | Checks the App Store Connect app record. Apple lets only an Apple ID login create it (App Store Connect → Apps → + → New App, with the bundle id); the API key can't. |

The first upload also needs the app record; after that, `fastlane beta` alone. Internal testers of the team see a new
build in the TestFlight app once it has been processed (a few minutes).

## Push environments

A development build (`fastlane device`, Xcode) gets an APNs **sandbox** token; TestFlight and App Store builds get
**production** tokens. The app tells the server which (from its embedded provisioning profile), and the server sends
each push to that token's environment.

## Development

DEBUG builds take two launch arguments: `-openPath /r/<folder>/decisions#d:<folder>:<id>` opens a page as a tapped push
would, `-showSettings 1` opens the settings. `-serverURL http://127.0.0.1:4321` points a simulator at a local server
(push registration is refused there: it needs a login or an answer device, like answers).
