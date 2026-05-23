# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A Manifest V3 Chrome extension that adds Chromecast support to Bandcamp. No build, lint, or test tooling — plain JS/CSS loaded unpacked.

## Development

- **Run:** `chrome://extensions` → Developer mode → "Load unpacked". After edits, reload the extension card *and* refresh the Bandcamp tab.
- **Icons:** `python3 tools/make_icons.py` regenerates `icons/`.
- **Debug:** the content script logs to the page console with the `[Bandcamp Cast]` prefix. No automated tests — verify manually against live Bandcamp pages with a real Cast device.

## Architecture

The Cast SDK runs in an iframe pointing to `https://bandcamp.com/?bcast=1`, **overlaid transparently on top of the Cast button** (`position: absolute; inset: 0; opacity: 0`). Album/track pages live on artist subdomains; the iframe is on `bandcamp.com`, so every Bandcamp tab's sender shares one origin — `ORIGIN_SCOPED` sessions auto-rejoin across subdomains. The click also lands on the iframe directly, which is the only way `requestSession()` gets user activation (Chrome won't propagate it cross-origin via `postMessage`).

The same content script `src/cast.js` runs in both contexts (manifest `all_frames: true`, `world: "MAIN"`) and branches on `inBcastFrame`:

- **Outer** (per tab): UI, page data (`data-tralbum`, `#carousel-player`), local `<audio>` capture, and the album-page mirror. No Cast SDK objects — only a `cast` state mirror updated from inner messages.
- **Inner** (iframe, `bandcamp.com`): owns the Cast SDK, session, `RemotePlayer`, and `loadMedia` / queue construction. Handles its own `click` for `requestSession` / `endCurrentSession`; everything else flows over `postMessage` (`playPause`, `seek`, `castAlbum`, `castSingle`; inner emits `state`, `session`, `ready`).

The receiver is a **Styled Media Receiver** registered in the Cast SDK Developer Console (Google-hosted, no receiver URL, zero permissions needed). `session_error` on start usually means the app hasn't propagated yet (~15 min after publish) or — for an unpublished app — the device isn't registered, or wasn't rebooted after registering.

**The Chromecast is the source of truth.** The album is sent as a queue and the receiver auto-advances, so playback survives tab switches and navigation. The local `<audio>` is muted while casting (and paused too on album pages — but only muted on collection pages, see below).

**Fan collection pages** (`bandcamp.com/<user>`, detected by `#carousel-player`) have no `data-tralbum`. There the extension casts the currently-playing track (`castSingle`), the local muted player acts as the user's remote (play/pause/seek forwarded via `carouselCasting()`), and there's no DOM mirror. Two quirks: `silenceLocal()` only mutes (never pauses) because the collection player retries `play()` when paused; and `onLocalPause` ignores pause events while the tab is hidden so Chrome's background-tab autopause doesn't stop the cast. The local stream is owner-only `mp3-v0` which the receiver can't fetch, so the inner's `castableUrlForTrack()` fetches a public `mp3-128` URL from Bandcamp's embed player.

**The album mirror** is active only while the cast track belongs to the open page (`mirroring`): the `cast` state drives Bandcamp's player DOM, and capture-phase listeners on the play button / progress bar route input back to the cast. Depends on Bandcamp's markup (`.inline_player`, `.playbutton`, `.progbar*`, `.track_row_view`).

A few things to know:

- Tracks are matched by Bandcamp's stable numeric `track_id` — stream URLs carry rotating tokens. `urlTrackId()` handles both URL shapes (a `track_id` query param, or the last path segment).
- Album queues are sent in `QUEUE_CHUNK`-sized chunks. The inner's `dispatchLoad()` serialises loads so overlapping `loadMedia` calls (Bandcamp fires `play` twice on a track switch) don't reject with `session_error`.
- The Cast SDK reports `currentTime` sporadically, so the outer keeps a local interpolating clock (`syncClock` / `estimatedTime` + 500ms ticker) for a smooth progress bar.
