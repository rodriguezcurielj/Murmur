// Where the player finds your Murmur server when it's opened from somewhere other than the
// server itself, such as GitHub Pages (https://rodriguezcurielj.github.io/Murmur/).
// Change this to your server's public https:// address once it has one (for example a
// Cloudflare Tunnel or Tailscale Funnel address). People can also type a different
// address on the "Connect to your Murmur" screen.
window.MURMUR_CONFIG = {
  // Current address from `docker logs murmur-tunnel`. It changes if the tunnel restarts.
  server: 'https://puzzle-saver-cookie-talking.trycloudflare.com'
};
