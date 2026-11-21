# Playlist Runtime

A Chrome / Edge extension that shows how long a YouTube playlist is, and how long it takes at 1.25×, 1.5×, 2×, 3× or any speed you type in.

## Install

**Chrome:** open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and choose this folder.

**Edge:** open `edge://extensions`, turn on **Developer mode** (left sidebar), click **Load unpacked**, and choose this folder.

Pin the extension so its icon stays in the toolbar.

## Use

Open a playlist on www.youtube.com (or a video playing from one), then click the icon.

- **Full length** is the total at normal speed, also shown in decimal hours.
- Drag the slider or type any speed (e.g. `2.3`) to see the time at that speed. Your speed is remembered.
- Click any row in the list to jump to that speed.
- **Count videos** limits the total to a range. If you're watching video 23 of a playlist, it starts from 23 automatically so you see what's left. Press **All** to count the whole thing.

## Notes

- Works with public, unlisted and your own private playlists, including Watch Later, as long as you're signed in.
- Videos with no length (private, deleted, live streams, upcoming premieres) are skipped and the popup tells you how many.
- YouTube Mixes (auto-generated, endless) have no fixed length, so they aren't supported.
- Results are cached for 15 minutes; the refresh button recounts.
- The extension only talks to youtube.com, from inside your YouTube tab. Nothing is sent anywhere else.
