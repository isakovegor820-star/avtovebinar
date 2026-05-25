(function () {
  const mount = document.querySelector("[data-flow-tabs]");
  if (!mount) return;

  const current = mount.dataset.current || "landing";
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const storedToken = localStorage.getItem("crisisPremiumToken") || "";
  const accessToken = token || storedToken;

  if (token) {
    localStorage.setItem("crisisPremiumToken", token);
  }

  if ((current === "success" || current === "webinar") && accessToken) {
    localStorage.setItem("crisisPremiumRegistered", "true");
  }

  const isRegistered = localStorage.getItem("crisisPremiumRegistered") === "true";
  const roomUnlocked = isRegistered && Boolean(accessToken);

  if (!roomUnlocked) {
    mount.remove();
    return;
  }

  const activeTab = current === "webinar" ? "webinar" : current === "landing" ? "landing" : "";
  const stages = [
    { id: "landing", label: "Сайт", href: "index.html", meta: "Главная" },
    {
      id: "webinar",
      label: "Вебинар",
      href: `webinar.html?token=${encodeURIComponent(accessToken)}`,
      meta: "Доступ открыт"
    }
  ];
  const hint =
    current === "success"
      ? "Регистрация принята"
      : "Вебинар доступен";

  mount.className = "flow-tabs";
  mount.innerHTML = `
    <div class="flow-tabs__inner">
      <div class="flow-tabs__label">Разделы</div>
      <nav class="flow-tabs__list" aria-label="Разделы вебинара">
        ${stages
          .map((stage) => {
            const index = stages.findIndex((item) => item.id === stage.id) + 1;
            const currentAttr = stage.id === activeTab ? ' aria-current="page"' : "";
            const lockedClass = stage.isLocked ? " flow-tabs__tab--locked" : "";
            return `
              <a class="flow-tabs__tab${lockedClass}" href="${stage.href}"${currentAttr}>
                <span class="flow-tabs__index">${index}</span>
                <span class="flow-tabs__copy">
                  <span>${stage.label}</span>
                  <span class="flow-tabs__meta">${stage.meta}</span>
                </span>
              </a>
            `;
          })
          .join("")}
      </nav>
      <div class="flow-tabs__hint">${hint}</div>
    </div>
  `;

  mount.querySelectorAll(".flow-tabs__tab").forEach((tab) => {
    tab.addEventListener("pointerdown", () => {
      tab.classList.add("flow-tabs__tab--pressed");
    });

    ["pointerup", "pointercancel", "mouseleave"].forEach((eventName) => {
      tab.addEventListener(eventName, () => {
        window.setTimeout(() => tab.classList.remove("flow-tabs__tab--pressed"), 120);
      });
    });
  });
})();
