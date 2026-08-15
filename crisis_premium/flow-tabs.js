(function () {
  const mount = document.querySelector("[data-flow-tabs]");
  if (!mount) return;

  const current = mount.dataset.current || "landing";

  let registeredWebinarHref = "webinar.html";

  function webinarHref() {
    return registeredWebinarHref;
  }

  function replaceLinkContent(link, label) {
    const icon = link.querySelector(".material-symbols-outlined")?.cloneNode(true) || null;
    link.replaceChildren();
    if (icon) {
      link.appendChild(icon);
      link.appendChild(document.createTextNode(" "));
    }
    link.appendChild(document.createTextNode(label));
  }

  function markRegisteredAccess(data) {
    const roomHref = data?.webinarUrl || "webinar.html";
    registeredWebinarHref = roomHref;

    document.querySelectorAll("[data-participant-access-link]").forEach((link) => {
      if (link.closest(".recordings-access-gate")) return;
      if (link.closest("#aspb-room-overlay")) return;
      link.setAttribute("href", "access.html");
      replaceLinkContent(link, "Мой доступ");
    });

    document.querySelectorAll('a[href$="webinar.html"], a[href*="webinar.html"]').forEach((link) => {
      if (link.id === "successRoomLink" || link.closest("[data-flow-tabs]") || link.textContent.includes("Комната")) {
        link.setAttribute("href", roomHref);
      }
    });
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

  function render(isLive = false) {
    mount.style.display = "";
    const activeTab =
      current === "landing"
        ? "landing"
        : current === "webinar"
        ? "webinar"
        : current === "recordings"
          ? "recordings"
          : "";
    const stages = [
      { id: "landing", label: "Главная", href: "index.html", icon: "home" },
      { id: "webinar", label: "Комната", href: webinarHref(), icon: "meeting_room" },
      { id: "recordings", label: "Записи", href: "recordings.html", icon: "video_library" }
    ];

    mount.className = ["flow-tabs", mount.dataset.extraClass || ""].filter(Boolean).join(" ");
    if (mount.dataset.stickyTop) {
      mount.style.setProperty("top", mount.dataset.stickyTop, "important");
    }
    mount.replaceChildren();

    const inner = el("div", { className: "flow-tabs__inner" });

    const nav = el("nav", { className: "flow-tabs__list" });
    nav.setAttribute("aria-label", "Навигация вебинара");

    stages.forEach((stage) => {
      const tab = el("a", {
        className: "flow-tabs__tab",
        href: stage.href,
        ariaCurrent: stage.id === activeTab ? "page" : ""
      });
      const icon = el("span", { className: "flow-tabs__icon material-symbols-outlined", text: stage.icon });
      icon.setAttribute("aria-hidden", "true");
      tab.appendChild(icon);

      const copy = el("span", { className: "flow-tabs__copy" });
      const labelWrapper = el("span", { className: "flow-tabs__title" });
      if (stage.id === "webinar" && isLive) {
        labelWrapper.appendChild(el("span", { className: "flow-tabs__live-dot" }));
      }
      labelWrapper.appendChild(el("span", { className: "flow-tabs__label-text", text: stage.label }));
      copy.appendChild(labelWrapper);
      
      if (stage.meta) {
        copy.appendChild(el("span", { className: "flow-tabs__meta", text: stage.meta }));
      }
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
    mount.appendChild(inner);
  }

  const api = window.location.protocol === "file:" ? "http://127.0.0.1:5174/api" : "/api";
  const fetchUrl = `${api}/registration/session/current`;

  function clearLocalAccessHint() {
    try {
      window.localStorage.removeItem("crisisPremiumRegistered");
    } catch {
      // Server state is authoritative.
    }
  }

  function applyRegistrationState(data) {
    if (!data?.ok) return false;

    const isLive = data.accessStatus === "live" || data.webinarStatus === "live" || data.webinar?.status === "live";
    markRegisteredAccess(data);
    window.setTimeout(() => markRegisteredAccess(data), 0);
    window.setTimeout(() => markRegisteredAccess(data), 800);

    render(isLive);
    return true;
  }

  window.addEventListener("aspb:registration-state", (event) => {
    applyRegistrationState(event.detail);
  });

  fetch(fetchUrl, { credentials: "include" })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (!data?.ok) {
        clearLocalAccessHint();
        mount.remove();
        return;
      }

      applyRegistrationState(data);
    })
    .catch(() => {
      mount.remove();
    });
})();
