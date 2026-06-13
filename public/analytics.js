(function () {
  const token = window.SITE_CONFIG?.cloudflareAnalyticsToken;
  if (!token) return;

  const s = document.createElement("script");
  s.defer = true;
  s.src = "https://static.cloudflareinsights.com/beacon.min.js";
  s.setAttribute("data-cf-beacon", JSON.stringify({ token, spa: false }));
  document.head.appendChild(s);
})();
