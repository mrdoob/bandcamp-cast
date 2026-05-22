# Bandcamp Cast

A Chrome extension that adds Chromecast support to Bandcamp.

Open a Bandcamp album, track, or fan collection page, click the Cast button,
and pick a device — the music streams to your Chromecast.

## Install

1. Run `python3 tools/make_icons.py` to generate the icons (one-time).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select this folder.
3. Open any Bandcamp album, track, or collection page.

## How it works

Casting hands the whole album to the Chromecast as a queue, so it auto-advances
and keeps playing when you switch tabs or close the page. While a casting track
is open in a tab, Bandcamp's own player mirrors it — the progress bar and
play/pause/scrub stay in sync. Skipping tracks and volume are done from Chrome's
Cast popup.

On a fan's collection page the Cast button sits in the bottom player bar and
casts the track playing there; play, pause, and seeking from that bar control
the cast.

Casting goes through a registered Cast receiver app ("Bandcamp Cast") — a
Styled Media Receiver set up in the Google Cast SDK Developer Console — so the
Chromecast and phones show that name along with the track and artist.

## Limitations

- Works on `*.bandcamp.com` pages only; custom artist domains aren't matched.
- On a collection page it casts the playing track, not the whole collection.
- Stopping the cast doesn't move the position back into Bandcamp's player.
- The player mirror relies on Bandcamp's current player markup.
- Requires Chrome 111+ and a Cast device on the same network.
