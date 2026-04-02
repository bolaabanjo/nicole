# Nicole macOS

This is the first local-only macOS client for Nicole.

You do not need the App Store for this.

## What it does today

- connects to your existing Nicole backend
- loads shared chat history from `/api/nicole/history`
- sends messages to `/api/nicole/stream`
- renders streaming replies live
- stores backend URL locally
- supports a compact and expanded window mode

## Run it

1. Open [Package.swift](/Users/apple/nicole/nicole-macos/Package.swift) in Xcode.
2. Let Xcode resolve the package.
3. Choose the `NicoleMacOS` scheme.
4. Run it.

Default backend:

- `http://127.0.0.1:3000`

If your Nicole server is somewhere else, open Settings in the app and change the base URL.

## Next Phase 2.5 upgrades

- global hotkey
- right-side overlay panel
- active app and window capture
- selected text and browser/file context
- screenshot-aware prompts
