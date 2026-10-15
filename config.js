// Where the player finds your Murmur server when it's opened from somewhere other than the
// server itself, such as GitHub Pages (https://rodriguezcurielj.github.io/Murmur/).
// Change this to your server's public https:// address once it has one (for example a
// Cloudflare Tunnel or Tailscale Funnel address). People can also type a different
// address on the "Connect to your Murmur" screen.
window.MURMUR_CONFIG = {
  // Servers people can pick from on the "Choose your server" screen. The first is the default;
  // if the chosen one can't be reached, Murmur uses another one from this list.
  servers: [
    // "Port Server": this laptop in Docker (Tailscale Funnel). This address doesn't change.
    { name: 'Port Server', url: 'https://murmur-laptop.tail05789d.ts.net' },
    // "Port Down Server": this laptop, native Windows server (start-native.ps1, Tailscale Funnel on 8443). "note" shows under its name;
    // downloads: true marks the server(s) that can download from YouTube (people on the others are sent there).
    { name: 'Port Down Server', url: 'https://murmur-laptop.tail05789d.ts.net:8443', note: 'Allows YouTube downloads', downloads: true },
    // "Hike Server": the always-on Azure server (Tailscale Funnel). This address doesn't change.
    { name: 'Hike Server', url: 'https://murmur.tail05789d.ts.net' }
  ]
};
