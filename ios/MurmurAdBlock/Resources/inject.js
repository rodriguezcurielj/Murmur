// Safari: content scripts run apart from the page, so this adds youtube-strip.js to YouTube's player page
// itself, where it can remove the ads from the data YouTube's player reads. Only inside Murmur (the script checks).
(function () {
  if (window === window.top) return;
  var s = document.createElement('script');
  s.src = browser.runtime.getURL('youtube-strip.js');
  s.onload = function () { s.remove(); };
  (document.head || document.documentElement).appendChild(s);
})();
