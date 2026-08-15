/* Premium Button Interactions: Magnetic & Spotlight effects */
(function () {
  // Disable magnetic effects on touch-only devices
  const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;

  function initPremiumButtons() {
    const buttons = document.querySelectorAll(".btn-premium");

    buttons.forEach((button) => {
      // 1. Dynamic children wrapping for Parallax magnetic support
      let content = button.querySelector(".btn-premium__content");
      if (!content) {
        content = document.createElement("div");
        content.className = "btn-premium__content";
        while (button.firstChild) {
          content.appendChild(button.firstChild);
        }
        button.appendChild(content);
      }

      // Find icons inside the wrapper and apply specific premium motion classes
      const icons = content.querySelectorAll(".material-symbols-outlined");
      icons.forEach((icon) => {
        if (!icon.classList.contains("btn-premium__icon")) {
          icon.classList.add("btn-premium__icon");
          const txt = icon.textContent.trim();
          if (txt === "arrow_forward" || txt === "east") {
            icon.classList.add("btn-premium__icon--arrow");
          } else if (txt === "send") {
            icon.classList.add("btn-premium__icon--telegram");
          } else if (txt === "content_copy" || txt === "copy" || txt === "filter_none") {
            icon.classList.add("btn-premium__icon--copy");
          }
        }
      });

      // State for magnetic lerping
      let state = {
        currentX: 0,
        currentY: 0,
        targetX: 0,
        targetY: 0,
        contentCurrentX: 0,
        contentCurrentY: 0,
        contentTargetX: 0,
        contentTargetY: 0,
        hovered: false,
        pressed: false,
        currentScale: 1,
        targetScale: 1,
        rect: null,
        rafId: null,
      };

      // 2. Mouse Move Tracker (Spotlight Coordinates + Magnetic Tilt)
      function onMouseMove(e) {
        if (!state.rect) return;
        const rect = state.rect;
        const scrollY = window.scrollY;
        const x = e.clientX - rect.left;
        const y = e.clientY - (rect.top - scrollY + scrollY);

        // Spotlight coordinates
        button.style.setProperty("--mouse-x", x + "px");
        button.style.setProperty("--mouse-y", y + "px");

        if (isTouchDevice) return;

        // Magnetic pull toward cursor center
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        const maxShift = 6;
        const maxContentShift = 3;

        state.targetX = ((x - centerX) / centerX) * maxShift;
        state.targetY = ((y - centerY) / centerY) * maxShift;
        state.contentTargetX = ((x - centerX) / centerX) * maxContentShift;
        state.contentTargetY = ((y - centerY) / centerY) * maxContentShift;
      }

      function onMouseEnter() {
        state.hovered = true;
        state.rect = button.getBoundingClientRect();
        startLerp();
      }

      function onMouseLeave() {
        state.hovered = false;
        state.targetX = 0;
        state.targetY = 0;
        state.contentTargetX = 0;
        state.contentTargetY = 0;
        button.style.removeProperty("--mouse-x");
        button.style.removeProperty("--mouse-y");
      }

      function onMouseDown() {
        state.pressed = true;
        state.targetScale = 0.95;
      }

      function onMouseUp() {
        state.pressed = false;
        state.targetScale = state.hovered ? 1.03 : 1;
        setTimeout(() => {
          if (!state.pressed) state.targetScale = 1;
        }, 200);
      }

      // Lerp animation loop
      function lerp(a, b, t) {
        return a + (b - a) * t;
      }

      function lerpLoop() {
        const t = 0.12;
        state.currentX = lerp(state.currentX, state.targetX, t);
        state.currentY = lerp(state.currentY, state.targetY, t);
        state.contentCurrentX = lerp(state.contentCurrentX, state.contentTargetX, t);
        state.contentCurrentY = lerp(state.contentCurrentY, state.contentTargetY, t);
        state.currentScale = lerp(state.currentScale, state.targetScale, t);

        const s = state.currentScale;
        button.style.transform = `translate(${state.currentX}px, ${state.currentY}px) scale(${s})`;
        content.style.transform = `translate(${state.contentCurrentX}px, ${state.contentCurrentY}px)`;

        const idle =
          Math.abs(state.currentX - state.targetX) < 0.05 &&
          Math.abs(state.currentY - state.targetY) < 0.05 &&
          Math.abs(state.currentScale - state.targetScale) < 0.001;

        if (idle && !state.hovered) {
          button.style.transform = "";
          content.style.transform = "";
          state.currentX = 0;
          state.currentY = 0;
          state.contentCurrentX = 0;
          state.contentCurrentY = 0;
          state.currentScale = 1;
          state.rafId = null;
          return;
        }

        state.rafId = requestAnimationFrame(lerpLoop);
      }

      function startLerp() {
        if (!state.rafId) {
          state.rafId = requestAnimationFrame(lerpLoop);
        }
      }

      // Bind events
      button.addEventListener("mousemove", onMouseMove);
      button.addEventListener("mouseenter", onMouseEnter);
      button.addEventListener("mouseleave", onMouseLeave);
      button.addEventListener("mousedown", onMouseDown);
      button.addEventListener("mouseup", onMouseUp);
    });
  }

  // Bento Card Interactive 3D Tilt with lerp
  function initBentoCards() {
    const cards = document.querySelectorAll(".bento-card-interactive");
    const MAX_TILT = 4; // degrees

    cards.forEach((card) => {
      let state = {
        currentRotX: 0,
        currentRotY: 0,
        targetRotX: 0,
        targetRotY: 0,
        hovered: false,
        rafId: null,
      };

      function lerp(a, b, t) {
        return a + (b - a) * t;
      }

      function onMouseMove(e) {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;

        state.targetRotY = ((x - centerX) / centerX) * MAX_TILT;
        state.targetRotX = -((y - centerY) / centerY) * MAX_TILT;

        // Update spotlight coordinates
        card.style.setProperty("--mouse-x", x + "px");
        card.style.setProperty("--mouse-y", y + "px");
      }

      function onMouseEnter() {
        state.hovered = true;
        startLoop();
      }

      function onMouseLeave() {
        state.hovered = false;
        state.targetRotX = 0;
        state.targetRotY = 0;
        card.style.removeProperty("--mouse-x");
        card.style.removeProperty("--mouse-y");
      }

      function loop() {
        const t = 0.08;
        state.currentRotX = lerp(state.currentRotX, state.targetRotX, t);
        state.currentRotY = lerp(state.currentRotY, state.targetRotY, t);

        card.style.transform = `perspective(800px) rotateX(${state.currentRotX}deg) rotateY(${state.currentRotY}deg)`;

        const idle =
          Math.abs(state.currentRotX - state.targetRotX) < 0.01 &&
          Math.abs(state.currentRotY - state.targetRotY) < 0.01;

        if (idle && !state.hovered) {
          card.style.transform = "";
          state.currentRotX = 0;
          state.currentRotY = 0;
          state.rafId = null;
          return;
        }

        state.rafId = requestAnimationFrame(loop);
      }

      function startLoop() {
        if (!state.rafId) {
          state.rafId = requestAnimationFrame(loop);
        }
      }

      card.addEventListener("mousemove", onMouseMove);
      card.addEventListener("mouseenter", onMouseEnter);
      card.addEventListener("mouseleave", onMouseLeave);
    });
  }

  // Initialize
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initPremiumButtons();
      initBentoCards();
    });
  } else {
    initPremiumButtons();
    initBentoCards();
  }
})();
