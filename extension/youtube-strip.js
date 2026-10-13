// Runs inside YouTube's embedded player, before YouTube's own code. YouTube tells its player which ads to
// play in the same data that describes the video; this removes those entries as the player reads them,
// so there's nothing to play (same idea as uBlock Origin's "json-prune" rule for YouTube).
// It only acts when the player is inside Murmur. Keep in step with the Android and iPhone apps.
(function () {
  var MURMUR = /(^|\.)(rodriguezcurielj\.github\.io|trycloudflare\.com|ts\.net)$|^(localhost|127\.0\.0\.1)$/;
  function inMurmur() {
    try {
      var anc = location.ancestorOrigins;
      if (anc && anc.length) {
        for (var i = 0; i < anc.length; i++) if (MURMUR.test(new URL(anc[i]).hostname)) return true;
        return false;
      }
      return !!document.referrer && MURMUR.test(new URL(document.referrer).hostname);   // Firefox has no ancestorOrigins
    } catch (e) { return false; }
  }
  if (window === window.top || !inMurmur()) return;
  if (window.__murmurAdStrip) return; window.__murmurAdStrip = true;

  var KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams', 'adBreakParams'];
  function strip(o, depth) {
    try {
      if (!o || typeof o !== 'object' || (depth || 0) > 4) return o;
      if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) strip(o[i], (depth || 0) + 1); return o; }
      for (var k = 0; k < KEYS.length; k++) if (KEYS[k] in o) delete o[KEYS[k]];
      if (o.playerResponse) strip(o.playerResponse, (depth || 0) + 1);
      if (o.response) strip(o.response, (depth || 0) + 1);
    } catch (e) {}
    return o;
  }
  var parse = JSON.parse;
  JSON.parse = function () { return strip(parse.apply(this, arguments)); };
  if (window.Response && Response.prototype.json) {
    var json = Response.prototype.json;
    Response.prototype.json = function () { return json.apply(this, arguments).then(function (v) { return strip(v); }); };
  }
  var initial;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: function () { return initial; },
      set: function (v) { initial = strip(v); }
    });
  } catch (e) {}
})();
