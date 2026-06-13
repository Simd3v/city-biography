(function () {
  const cfg = window.SITE_CONFIG || {};
  const token = cfg.cloudflareAnalyticsToken;

  if (token) {
    const s = document.createElement("script");
    s.defer = true;
    s.src = "https://static.cloudflareinsights.com/beacon.min.js";
    s.setAttribute("data-cf-beacon", JSON.stringify({ token, spa: false }));
    document.head.appendChild(s);
    return;
  }

  /* Zero-setup fallback: anonymous visit counter (no cookies, no account). */
  try {
    fetch("https://api.countapi.xyz/hit/simd3v-city-biography/visits", {
      mode: "no-cors",
      keepalive: true,
    });
  } catch {
    /* ignore */
  }
})();
