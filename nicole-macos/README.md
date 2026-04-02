# Nicole macOS

This is the first local-only macOS client for Nicole.

You do not need the App Store for this.

## What it does today

- connects to your existing Nicole backend
- stores a friendly name for your canonical Nicole server
- loads shared chat history from `/api/nicole/history`
- sends messages to `/api/nicole/stream`
- renders streaming replies live
- stores Nicole server settings locally
- supports a compact and expanded window mode

## Run it

1. Open [Package.swift](/Users/apple/nicole/nicole-macos/Package.swift) in Xcode.
2. Let Xcode resolve the package.
3. Choose the `NicoleMacOS` scheme.
4. Run it.

Canonical server:

- set a friendly name like `Banjo`
- set the server URL to your actual Nicole backend origin, for example `http://banjo.local:3000`

If you're developing locally, you can still point it at a local server. But the intended setup is one canonical Nicole backend and this app as the native client.

## Next Phase 2.5 upgrades

- global hotkey
- right-side overlay panel
- active app and window capture
- selected text and browser/file context
- screenshot-aware prompts
