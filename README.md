# Little Pomegranate

English | [简体中文](README.zh-CN.md)

An open-source (MIT) multi-model AI chat client built from a static web chat frontend. It runs purely client-side with support for a native protocol, OpenAI-compatible endpoints (`/chat/completions` & `/responses`), local deployments (Ollama / LM Studio / vLLM / LocalAI), and Android packaging via Capacitor.

This repository is a personalized Little Pomegranate build with independent branding,
package identity, and release signing.

## Features

- **Multi-Protocol & Local Deployment**: Native API, OpenAI Chat Completions, OpenAI Responses API, and keyless local server presets (Ollama, LM Studio, vLLM, LocalAI) with automatic model discovery.
- **Independent Multi-Modal Channels**: Separate provider endpoints/keys/models for ASR, TTS, Vision, OCR, and Image Generation (text-to-image & image-to-image with aspect-ratio matching and optional pre-generation confirmation).
- **Voice Call & Camera Switching**: Continuous voice call overlay with live camera preview and mobile front/back camera switch, plus a header speaker toggle for automatic voice readout of replies.
- **Long-Term Memory & Policies**: Auto-extracted and editable long-term saved memories, configurable cross-chat memory recall, assistant reply branching edits, and custom keyword refusal rules.
- **Token Usage & Daily Threshold Alerts**: Displays per-turn token usage beneath assistant replies and tracks daily cumulative usage with a customizable threshold alert modal.
- **Chat History Backup**: Full ZIP import/export compatible with `export_format_version: 3` archives.
- **In-App Update Checker**: Checks GitHub Releases for new versions, renders the release changelog inside the app, and lets users choose to install, stay on their current version, or skip a release.

## Development & Hosting

Requires Node.js 22+ and pnpm:

```sh
cd D:/Codex/DeepJeek-src
pnpm install
pnpm dev
```

Open http://localhost:8090 .

Build static assets and serve locally with built-in `/__api_proxy__` CORS/proxy forwarding:

```sh
pnpm build
pnpm preview
```

## Android APK & Automated Releases

Build locally:

```sh
pnpm run android:sync
cd android && ./gradlew assembleRelease
```

To enable automated signed APK releases via GitHub Actions on `v*` tags, configure the following repository Secrets under `Settings → Secrets and variables → Actions`:

- `SIGNING_KEYSTORE_BASE64`: Base64-encoded Android signing keystore (keep using your original keystore so existing users can update in-place without losing local chats)
- `SIGNING_KEYSTORE_PASS` (optional, defaults to `android`)
- `SIGNING_KEY_ALIAS` (optional, defaults to `androiddebugkey`)
- `SIGNING_KEY_PASS` (optional, defaults to `android`)

## License

[MIT License](LICENSE)
