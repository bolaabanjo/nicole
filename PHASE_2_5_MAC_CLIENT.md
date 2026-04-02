# Phase 2.5 — Native Mac Client Contract

Nicole does not need the App Store to start.

- For your own Macs, you can run the native app directly from Xcode.
- For wider distribution outside the App Store, you would eventually sign and notarize it with Apple.
- The App Store is optional and only matters if you want App Store distribution.

## Current split

- `nicole` stays the shared brain and API.
- `nicole-macos` will be the native Swift client.

## Chat request contract

The existing Nicole chat routes now accept optional workspace context:

- `POST /api/nicole`
- `POST /api/nicole/stream`

Request shape:

```json
{
  "message": "explain this to me",
  "context": {
    "surface": "macos",
    "activeApp": "Safari",
    "windowTitle": "Attention Is All You Need - PDF",
    "selectedText": "Scaled dot-product attention...",
    "clipboardText": "Transformer notes",
    "currentUrl": "https://arxiv.org/abs/1706.03762",
    "currentFilePath": "/Users/apple/Documents/papers/attention.pdf",
    "visibleContent": "Section 3 explains the architecture...",
    "note": "User triggered Nicole with the global hotkey."
  }
}
```

Every field in `context` is optional. Nicole only uses the fields that are present.

## Context validation route

For native client development, this route now exists:

- `POST /api/nicole/context`

Request:

```json
{
  "context": {
    "surface": "macos",
    "activeApp": "Xcode",
    "windowTitle": "router.ts"
  }
}
```

Response:

```json
{
  "context": {
    "surface": "macos",
    "activeApp": "Xcode",
    "windowTitle": "router.ts"
  },
  "summary": "- Surface: macos\n- Active app: Xcode\n- Window title: router.ts\n\nTreat this as the user's current workspace. Use it when it helps. If it seems stale or incomplete, say that plainly instead of guessing.",
  "ready": true
}
```

## Recommended Phase 2.5 build order

1. Create `nicole-macos` as a separate SwiftUI app.
2. Build a compact right-side overlay panel with a global hotkey.
3. Connect the app to `POST /api/nicole/stream`.
4. Send native workspace context with each message.
5. Add an expanded mode for longer sessions.

## First native payload we should support

These fields are enough for the first real Mac build:

- `surface`
- `activeApp`
- `windowTitle`
- `selectedText`
- `currentUrl`
- `currentFilePath`
- `clipboardText`

Everything else can layer in later without changing the contract.
