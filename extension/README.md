# Murmur Ad Blocker (browser extension)

Removes ads from YouTube songs when you use Murmur in a desktop browser. A web page can't reach inside YouTube's player, so this has to be an extension. The Android and iPhone apps have the same blocker built in.

It only acts on YouTube players embedded in Murmur (GitHub Pages, your tunnel address, localhost); your regular YouTube browsing is left alone.

## Install (Chrome, Edge, Brave)

1. Download `murmur-adblock.zip` from the [download page](https://rodriguezcurielj.github.io/Murmur/apps/) and unzip it (or use this `extension` folder).
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped folder.
5. Reload Murmur. Your account menu shows **YouTube ad blocker: On**.

## Install (Firefox)

Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and pick `manifest.json`. Firefox removes temporary add-ons when it closes.

## How it works

YouTube sends its player the ad instructions in the same data that describes the video. `youtube-strip.js` runs inside the player before YouTube's code and deletes those entries, so there's nothing to play. This is the same technique uBlock Origin uses, and it's best-effort: YouTube changes how it serves ads from time to time.
