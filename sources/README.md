# Download sources

A download source is a place Murmur can legally get a song's audio file from. People use it from a song's
**⋯ → Find a downloadable copy**, or from **Search → Search download sources**. Picking a result downloads the
file on the server and adds it to Murmur like an upload. If it replaces an imported or suggested song, that song
now plays from the file, and the **Download playlist/album** buttons can save it for offline listening.

The owner switches sources on and off, and enters any keys, under **People & settings → Download sources**.

## Included

| Source | Key | What you get |
| --- | --- | --- |
| `audius.js` | none | Tracks whose artist made them freely downloadable on Audius |
| `jamendo.js` | free Client ID from [devportal.jamendo.com](https://devportal.jamendo.com) | Creative Commons music, free for personal listening |

## Adding a paid or licensed source

1. Copy `_template.js` to a new file, for example `mystore.js`.
2. Fill in `search()` (find songs) and `download()` (buy if needed, then return a link to the file).
   Set `paid: true` and return a `price`/`priceLabel` for each result. Murmur then asks people to
   confirm before it buys anything.
3. Restart Murmur, open **People & settings → Download sources**, paste the key and switch it on.

Only connect services that give you the right to keep the file:

- **A store with an API** that sells DRM-free downloads to your own account.
- **A licensed music catalog for apps.** These are B2B services that license major-label music to apps
  and include download or offline rights. They require a business agreement with the provider.
- **Free and Creative Commons catalogs**, like the two included.

Services that pull audio out of YouTube or other streaming sites (YTMP3, SaveFrom, yt-dlp-based APIs)
don't give you those rights and break those sites' terms, so they don't belong here.
