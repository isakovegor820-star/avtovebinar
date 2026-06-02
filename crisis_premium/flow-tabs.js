(function () {
  const mount = document.querySelector("[data-flow-tabs]");
  if (!mount) return;

  const current = mount.dataset.current || "landing";

  const storage = {
    get(key) {
      try {
        return window.localStorage.getItem(key) || "";
      } catch {
        return "";
      }
    },
  };

  function webinarHref() {
    return "webinar.html";
  }

  function el(tag, options = {}, children = []) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text) node.textContent = options.text;
    if (options.href) node.setAttribute("href", options.href);
    if (options.ariaCurrent) node.setAttribute("aria-current", options.ariaCurrent);
    children.forEach((child) => node.appendChild(child));
    return node;
  }

  function render(hintText, isLive = false, scheduledAt = null, serverTime = null) {
    const activeTab = current === "webinar" ? "webinar" : current === "landing" ? "landing" : "";
    const stages = [
      { id: "landing", label: "Главная", href: "index.html", meta: "Сайт" },
      { id: "webinar", label: "Вебинар", href: webinarHref(), meta: isLive ? "Идет эфир" : "Доступ открыт" }
    ];

    mount.className = "flow-tabs";
    mount.replaceChildren();

    const inner = el("div", { className: "flow-tabs__inner" });
    inner.appendChild(el("div", { className: "flow-tabs__label", text: "Разделы" }));

    const nav = el("nav", { className: "flow-tabs__list" });
    nav.setAttribute("aria-label", "Разделы вебинара");

    stages.forEach((stage, index) => {
      const tab = el("a", {
        className: "flow-tabs__tab",
        href: stage.href,
        ariaCurrent: stage.id === activeTab ? "page" : ""
      });
      tab.appendChild(el("span", { className: "flow-tabs__index", text: String(index + 1) }));

      const copy = el("span", { className: "flow-tabs__copy" });
      const labelWrapper = el("span", { style: "display:inline-flex;align-items:center;gap:6px" });
      if (stage.id === "webinar" && isLive) {
        labelWrapper.appendChild(el("span", { className: "flow-tabs__live-dot" }));
      }
      labelWrapper.appendChild(el("span", { text: stage.label }));
      copy.appendChild(labelWrapper);
      
      copy.appendChild(el("span", { className: "flow-tabs__meta", text: stage.meta }));
      tab.appendChild(copy);

      tab.addEventListener("pointerdown", () => {
        tab.classList.add("flow-tabs__tab--pressed");
      });

      ["pointerup", "pointercancel", "mouseleave"].forEach((eventName) => {
        tab.addEventListener(eventName, () => {
          window.setTimeout(() => tab.classList.remove("flow-tabs__tab--pressed"), 120);
        });
      });

      nav.appendChild(tab);
    });

    inner.appendChild(nav);

    const hintNode = el("div", { className: "flow-tabs__hint", text: hintText });
    inner.appendChild(hintNode);
    mount.appendChild(inner);

    if (scheduledAt && !isLive) {
      const target = new Date(scheduledAt).getTime();
      const offset = serverTime ? new Date(serverTime).getTime() - Date.now() : 0;

      function tick() {
        const diff = Math.max(0, target - (Date.now() + offset));
        if (diff <= 0) {
          hintNode.innerHTML = `<span class="flow-tabs__live-dot"></span>ЭФИР ИДЕТ`;
          return;
        }
        const total = Math.floor(diff / 1000);
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        const pad = (v) => String(v).padStart(2, '0');
        hintNode.textContent = `До начала: ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
      }

      tick();
      window.setInterval(tick, 1000);
    } else if (isLive) {
      hintNode.innerHTML = `<span class="flow-tabs__live-dot"></span>ЭФИР ИДЕТ`;
    }
  }

  const isRegistered = storage.get("crisisPremiumRegistered") === "true";
  const api = window.location.protocol === "file:" ? "http://127.0.0.1:5174/api" : "/api";
  const fetchUrl = `${api}/registration/session/current`;

  fetch(fetchUrl, { credentials: "include" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (!data?.ok) {
        if (isRegistered) {
          render(current === "success" ? "Регистрация принята" : "Вебинар доступен", false, null);
        } else {
          mount.remove();
        }
        return;
      }

      const isLive = data.accessStatus === "live" || data.webinarStatus === "live" || data.webinar?.status === "live";
      const scheduledAt = data.webinar?.scheduledAt;
      const serverTime = data.serverTime;

      let hintText = "Вебинар доступен";
      if (current === "success") {
        hintText = "Регистрация принята";
      } else if (isLive) {
        hintText = "Эфир идет";
      }

      render(hintText, isLive, scheduledAt, serverTime);
    })
    .catch(() => {
      if (isRegistered) {
        render(current === "success" ? "Регистрация принята" : "Вебинар доступен", false, null);
      } else {
        mount.remove();
      }
    });
})();
