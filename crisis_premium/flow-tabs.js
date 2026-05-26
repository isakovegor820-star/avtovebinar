(function () {
  const mount = document.querySelector("[data-flow-tabs]");
  if (!mount) return;

  const current = mount.dataset.current || "landing";
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get("token") || "";
  const allowLocalTokenStorage =
    window.location.protocol === "file:" ||
    ["localhost", "127.0.0.1", ""].includes(window.location.hostname);

  const storage = {
    get(key) {
      try {
        if (key === "crisisPremiumToken" && !allowLocalTokenStorage) return "";
        return window.localStorage.getItem(key) || "";
      } catch {
        return "";
      }
    },
    set(key, value) {
      try {
        if (key === "crisisPremiumToken" && !allowLocalTokenStorage) return;
        window.localStorage.setItem(key, value);
      } catch {
        // Storage can be blocked in file previews; cookie/session access still works.
      }
    }
  };

  const storedToken = storage.get("crisisPremiumToken");
  const accessToken = urlToken || storedToken;

  if (urlToken) {
    storage.set("crisisPremiumToken", urlToken);
  }

  if ((current === "success" || current === "webinar") && accessToken) {
    storage.set("crisisPremiumRegistered", "true");
  }

  function webinarHref(token) {
    return token ? `webinar.html?token=${encodeURIComponent(token)}` : "webinar.html";
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

  function render(token, hintText) {
    const activeTab = current === "webinar" ? "webinar" : current === "landing" ? "landing" : "";
    const stages = [
      { id: "landing", label: "Сайт", href: "index.html", meta: "Главная" },
      { id: "webinar", label: "Вебинар", href: webinarHref(token), meta: "Доступ открыт" }
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
      copy.appendChild(el("span", { text: stage.label }));
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
    inner.appendChild(el("div", { className: "flow-tabs__hint", text: hintText }));
    mount.appendChild(inner);
  }

  const isRegistered = storage.get("crisisPremiumRegistered") === "true";
  if (accessToken || isRegistered) {
    render(accessToken, current === "success" ? "Регистрация принята" : "Вебинар доступен");
    return;
  }

  const api = window.location.protocol === "file:" ? "http://127.0.0.1:5174/api" : "/api";
  fetch(`${api}/registration/session/current`, { credentials: "include" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (!data?.ok) {
        mount.remove();
        return;
      }
      render("", "Вебинар доступен");
    })
    .catch(() => mount.remove());
})();
