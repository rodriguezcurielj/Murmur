// Where the player finds your Murmur server when it's opened from somewhere other than the
// server itself, such as GitHub Pages (https://rodriguezcurielj.github.io/Murmur/).
// Change this to your server's public https:// address once it has one (for example a
// Cloudflare Tunnel or Tailscale Funnel address). People can also type a different
// address on the "Connect to your Murmur" screen.
window.MURMUR_CONFIG = {
  // Servers people can pick from on the "Choose your server" screen. The first is the default;
  // if the chosen one can't be reached, Murmur uses another one from this list.
  servers: [
    // This laptop (Tailscale Funnel). This address doesn't change.
    { name: 'Laptop', url: 'https://murmur-laptop.tail05789d.ts.net' },
    // The always-on Azure server (Tailscale Funnel). This address doesn't change.
    { name: 'Azure', url: 'https://murmur.tail05789d.ts.net' }
  ]
};
