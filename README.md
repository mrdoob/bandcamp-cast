# Bandcamp Cast

A Chrome extension that adds Chromecast support to Bandcamp.

Open a Bandcamp album or track page, click the Cast button in the top-right of
the player, and pick a device — the album streams to your Chromecast.

## Install

1. Run `python3 tools/make_icons.py` to generate the icons (one-time).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select this folder.
3. Open any Bandcamp album or track page.

## How it works

Casting hands the whole album to the Chromecast as a queue, so it auto-advances
and keeps playing when you switch tabs or close the page. While a casting track
is open in a tab, Bandcamp's own player mirrors it — the progress bar and
play/pause/scrub stay in sync. Skipping tracks and volume are done from Chrome's
Cast popup.

Casting goes through a registered Cast receiver app ("Bandcamp Cast") — a
Styled Media Receiver set up in the Google Cast SDK Developer Console — so the
Chromecast and phones show that name along with the track and artist.

## Limitations

- Works on `*.bandcamp.com` pages only; custom artist domains aren't matched.
- Stopping the cast doesn't move the position back into Bandcamp's player.
- The player mirror relies on Bandcamp's current player markup.
- Requires Chrome 111+ and a Cast device on the same network.
