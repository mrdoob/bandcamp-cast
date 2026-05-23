# Bandcamp Cast

A Chrome extension that adds Chromecast support to Bandcamp.

Open a Bandcamp album, track, or fan collection page, click the Cast button,
and pick a device — the music streams to your Chromecast.

## Install

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select this folder.
2. Open any Bandcamp album, track, or collection page.

## How it works

Casting hands the whole album to the Chromecast as a queue, so it auto-advances
and keeps playing when you switch tabs, close the page, or browse to a different
artist on Bandcamp. Bandcamp's own player mirrors the cast — progress bar and
play/pause/scrub stay in sync; track skipping and volume are on Chrome's Cast
popup. On a fan collection page the button is in the bottom player bar and casts
the track playing there.

Casting goes through a registered Cast receiver app, so the device shows
"Bandcamp Cast" with the track and artist.

## Limitations

- Works on `*.bandcamp.com` pages only; custom artist domains aren't matched.
- On a collection page it casts the playing track, not the whole collection.
- Stopping the cast doesn't move the position back into Bandcamp's player.
- The player mirror relies on Bandcamp's current player markup.
- Requires Chrome 111+ and a Cast device on the same network.
