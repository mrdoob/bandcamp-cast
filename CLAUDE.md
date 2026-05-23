# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A Manifest V3 Chrome extension that adds Chromecast support to Bandcamp. No build, lint, or test tooling — plain JS/CSS loaded unpacked.

## Development

- **Run:** `chrome://extensions` → Developer mode → "Load unpacked". After edits, reload the extension card *and* refresh the Bandcamp tab.
- **Icons:** `python3 tools/make_icons.py` regenerates `icons/`.
- **Debug:** the content script logs to the page console with the `[Bandcamp Cast]` prefix. No automated tests — verify manually against live Bandcamp pages with a real Cast device.

## Architecture

The Cast SDK runs in an iframe we inject on every Bandcamp page, pointing to `https://bandcamp.com/?bcast=1`. Album/track pages live on artist subdomains (`<artist>.bandcamp.com`); the iframe loads `bandcamp.com` itself — so the sender's origin is the same on every Bandcamp tab. Cast sessions are `ORIGIN_SCOPED`, so this gives auto-rejoin across artist subdomains: the cast keeps playing and the button on the new page picks it up.

The iframe is **overlaid transparently on top of the Cast button** (`position: absolute; inset: 0; opacity: 0`), not hidden off-screen. The reason: Chrome does not propagate user activation cross-origin via `postMessage`, so a click in the outer can't authorise the iframe's `requestSession()`. By routing the click *through* the iframe instead, user activation registers on the `bandcamp.com` frame directly. The inner has its own `click` listener for `requestSession` / `endCurrentSession`; everything else flows over `postMessage`.

The same content script `src/cast.js` runs in both contexts (manifest `all_frames: true`, `world: "MAIN"`) and branches at the top on `inBcastFrame`:

- **Outer** (per tab): UI button, page-data extraction (`data-tralbum`, `#carousel-player`), local `<audio>` capture, and the player mirror onto Bandcamp's own DOM. Holds no Cast SDK objects — only a `cast` state object updated from inner messages.
- **Inner** (in the iframe, on `bandcamp.com`): owns the Cast SDK, `CastContext`, `RemotePlayer`, the session, and `loadMedia` / queue construction. Broadcasts state on every relevant event.

They talk over `postMessage`. Outer → inner commands: `playPause`, `seek`, `castAlbum`, `castSingle`. Inner → outer events: `state` (the broadcast snapshot), `session` (`started` / `resumed` / `ended`), and a one-time `ready`. Session start/stop are handled by the inner's click listener directly (it needs the user activation).

The receiver is a **Styled Media Receiver** — Google-hosted, so only the app ID is registered (no receiver URL or hosting to maintain). The SDK script is added in the inner via `createElement`, which Bandcamp's `strict-dynamic` CSP permits — so the extension modifies no CSP and needs zero permissions. A `session_error` when starting a cast means the receiver app didn't launch: usually a freshly published app that hasn't propagated yet (~15 min), or — for an unpublished app — a Cast device not registered for testing, or not rebooted after registering.

**The Chromecast is the source of truth.** The whole album is handed to the receiver as a queue, which plays and auto-advances on its own — so playback survives tab switches and navigation. Bandcamp's local `<audio>` is muted while casting (and, on album pages, paused as well).

**The player mirror** is active only while the cast track belongs to the open page (`mirroring`): the `cast` state (forwarded from the inner) drives Bandcamp's player DOM, and capture-phase listeners on its play button / progress bar route input back to the cast. Page-reload catch-up is handled by the inner: it auto-rejoins the live session on load and broadcasts state, so the outer's `cast` mirror — and therefore the player mirror — light up without polling.

**Fan collection pages** (`bandcamp.com/<user>`) have no `data-tralbum`; they are detected by the `#carousel-player` bar. There the extension casts the currently-playing track (`castSingle`), not a queue. The collection's local `<audio>` streams owner-only `mp3-v0` which the receiver can't fetch — the inner's `castableUrlForTrack()` fetches a public `mp3-128` stream from Bandcamp's same-origin embed player. There is no DOM mirror; the muted local player stays the user's remote and its play / pause / seek are forwarded to the cast (`carouselCasting()`). Two collection-only quirks: `silenceLocal()` only mutes (never pauses), because the collection player retries `play()` when paused and would fight the cast; and `onLocalPause` ignores pause events while the tab is hidden, so Chrome's background-tab autopause doesn't stop the cast.

A few things to know:

- Tracks are matched by Bandcamp's stable numeric `track_id`, never by URL — stream URLs carry rotating tokens and the format key changes after a purchase. `urlTrackId()` extracts the ID from either URL shape Bandcamp uses: a `track_id` query parameter (`stream_redirect` URLs) or the last path segment (`.../stream/<hash>/<format>/<id>`).
- The album is handed to the receiver in chunks of `QUEUE_CHUNK` tracks. The inner's `dispatchLoad()` serialises album and single-track loads through one pending-job slot — Bandcamp fires `play` twice on a track switch, and overlapping `loadMedia` calls would make the receiver reject one with `session_error`.
- The Cast SDK reports `currentTime` only sporadically, so the outer keeps a local interpolating clock (`syncClock` / `estimatedTime` + a 500ms ticker) to move the progress bar smoothly.

The mirror depends on Bandcamp's player markup (`.inline_player`, `.playbutton`, `.progbar*`, `.track_row_view`); a Bandcamp redesign would break it.
