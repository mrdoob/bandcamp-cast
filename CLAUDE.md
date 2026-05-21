# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A Manifest V3 Chrome extension that adds Chromecast support to Bandcamp. No build, lint, or test tooling — plain JS/CSS loaded unpacked.

## Development

- **Run:** `chrome://extensions` → Developer mode → "Load unpacked". After edits, reload the extension card *and* refresh the Bandcamp tab.
- **Icons:** `python3 tools/make_icons.py` regenerates `icons/`.
- **Debug:** the content script logs to the page console with the `[Bandcamp Cast]` prefix. No automated tests — verify manually against live Bandcamp pages with a real Cast device.

## Architecture

The extension is one content script, `src/cast.js`, injected into `*.bandcamp.com` with **`world: "MAIN"`** so it can read Bandcamp's `data-tralbum` data, patch `HTMLMediaElement.prototype.play`, and inject the Cast SDK. The SDK `<script>` is added via `createElement`, which Bandcamp's `strict-dynamic` CSP permits — so the extension modifies no CSP and needs zero permissions.

**The Chromecast is the source of truth.** Casting sends the whole album as a Cast queue (Default Media Receiver), which plays and auto-advances on its own, so playback survives tab switches. Bandcamp's `<audio>` is paused + muted while casting — Chrome suspends muted background audio, which is why a page-driven approach doesn't work.

**The player mirror** is active only while the cast track belongs to the open page (`mirroring`): `RemotePlayer` events drive Bandcamp's player DOM (display), and capture-phase listeners on its play button / progress bar route input to the cast (control).

Two things to know:

- Tracks are matched by Bandcamp's stable numeric `track_id`, never by URL — stream URLs carry rotating tokens and the format key changes after a purchase. `urlTrackId()` extracts the ID from any stream URL.
- The Cast SDK reports `currentTime` only sporadically, so `cast.js` keeps a local interpolating clock (`syncClock` / `estimatedTime` + a 500ms ticker) to move the progress bar smoothly.

The mirror depends on Bandcamp's player markup (`.inline_player`, `.playbutton`, `.progbar*`, `.track_row_view`); a Bandcamp redesign would break it.
