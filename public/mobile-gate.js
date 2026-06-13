(function () {
  const STORAGE_KEY = "city-biography-force-desktop";
  const CITIES = [
    { id: "abu-dhabi", name: "Abu Dhabi" },
    { id: "dubai", name: "Dubai" },
  ];

  function isMobileContext() {
    const ua = navigator.userAgent || "";
    const mobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    const narrowTouch =
      window.matchMedia("(max-width: 900px)").matches && window.matchMedia("(pointer: coarse)").matches;
    const lowMemory = typeof navigator.deviceMemory === "number" && navigator.deviceMemory < 4;
    return mobileUA || narrowTouch || lowMemory;
  }

  function shouldBlockMap() {
    if (localStorage.getItem(STORAGE_KEY) === "1") return false;
    return isMobileContext();
  }

  window.MOBILE_GATE_SKIP = shouldBlockMap();

  function previewSrc(cityId) {
    return `previews/${cityId}-black.jpg`;
  }

  function mountGate() {
    if (!window.MOBILE_GATE_SKIP) return;

    const gate = document.getElementById("mobile-gate");
    if (!gate) return;

    let activeCity = CITIES[0].id;
    const img = gate.querySelector(".mobile-gate-preview");
    const cityLabel = gate.querySelector(".mobile-gate-city");
    const cityBtns = gate.querySelectorAll("[data-preview-city]");

    function setCity(cityId) {
      activeCity = cityId;
      const city = CITIES.find((c) => c.id === cityId) || CITIES[0];
      cityLabel.textContent = city.name;
      img.src = previewSrc(cityId);
      img.alt = `${city.name} building age map preview`;
      cityBtns.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.previewCity === cityId);
      });
    }

    cityBtns.forEach((btn) => {
      btn.addEventListener("click", () => setCity(btn.dataset.previewCity));
    });

    gate.querySelector(".mobile-gate-dismiss")?.addEventListener("click", () => {
      localStorage.setItem(STORAGE_KEY, "1");
      gate.classList.remove("is-visible");
      window.MOBILE_GATE_SKIP = false;
      window.dispatchEvent(new Event("mobile-gate-dismissed"));
    });

    setCity(activeCity);
    gate.classList.add("is-visible");
    document.getElementById("loading")?.classList.add("hidden");
    document.getElementById("sidebar")?.style.setProperty("visibility", "hidden");
    document.getElementById("map")?.style.setProperty("visibility", "hidden");
  }

  window.MobileGate = { shouldBlockMap };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountGate);
  } else {
    mountGate();
  }
})();
