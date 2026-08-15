(function(){
  document.documentElement.classList.add('js-reveal');

  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.card-reveal').forEach(function(el){
      el.classList.add('is-visible');
    });
  } else {
    const observer = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if(entry.isIntersecting){
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },{threshold:0.15});
    document.querySelectorAll('.card-reveal').forEach(function(el){observer.observe(el);});
  }

  // 3D Tilt effect for bento cards
  document.querySelectorAll('.bento-card-tilt').forEach(function(card){
    card.addEventListener('mousemove', function(e){
      var rect = card.getBoundingClientRect();
      var x = (e.clientX - rect.left) / rect.width - 0.5;
      var y = (e.clientY - rect.top) / rect.height - 0.5;
      card.style.transform = 'rotateY(' + (x * 6) + 'deg) rotateX(' + (-y * 4) + 'deg) scale(1.01)';
    });
    card.addEventListener('mouseleave', function(){
      card.style.transform = 'rotateY(0deg) rotateX(0deg) scale(1)';
    });
  });

  // Segmented tabs switching
  document.querySelectorAll('.seg-tabs').forEach(function(tablist) {
    var tabs = tablist.querySelectorAll('.seg-tab');
    var panel = tablist.parentElement.querySelector('.seg-panel-text');
    tabs.forEach(function(tab) {
      tab.addEventListener('click', function() {
        tabs.forEach(function(t) { t.classList.remove('seg-tab--active'); t.setAttribute('aria-selected','false'); });
        tab.classList.add('seg-tab--active');
        tab.setAttribute('aria-selected','true');
        if (panel) {
          var key = 'data-text-' + tab.getAttribute('data-tab');
          var newText = panel.getAttribute(key);
          if (newText) {
            panel.style.animation = 'none';
            panel.offsetHeight;
            panel.style.animation = '';
            panel.textContent = newText;
          }
        }
      });
    });
  });

  // Count-up animation on scroll
  var countupObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      var el = entry.target;
      countupObserver.unobserve(el);
      var target = Number(el.getAttribute('data-countup'));
      var display = el.getAttribute('data-countup-display');
      var suffix = el.getAttribute('data-countup-suffix') || '';
      var duration = 1800;
      var start = performance.now();

      function step(now) {
        var progress = Math.min((now - start) / duration, 1);
        var eased = 1 - Math.pow(1 - progress, 3);
        var current = Math.floor(eased * target);

        if (display) {
          // For "2.2 млн" style — interpolate to display value
          var displayNum = parseFloat(display);
          var currentDisplay = (eased * displayNum).toFixed(1);
          el.textContent = currentDisplay.replace('.', ',') + suffix;
        } else {
          el.textContent = current.toLocaleString('ru-RU') + suffix;
        }

        if (progress < 1) {
          requestAnimationFrame(step);
        }
      }
      requestAnimationFrame(step);
    });
  }, { threshold: 0.3 });

  document.querySelectorAll('[data-countup]').forEach(function(el) {
    countupObserver.observe(el);
  });

  document.querySelectorAll('.flip-card').forEach(function(card) {
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    setFlipCardState(card, false);
    card.addEventListener('click', function() {
      card.dataset.flipInteracted = 'true';
      setFlipCardState(card, !card.classList.contains('is-flipped'));
    });
    card.addEventListener('keydown', function(event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      card.dataset.flipInteracted = 'true';
      setFlipCardState(card, !card.classList.contains('is-flipped'));
    });
  });
})();

function setFlipCardState(card, expanded) {
  var front = card.querySelector('.flip-card-front');
  var back = card.querySelector('.flip-card-back');
  var titleNode = front && front.querySelector('h2, h3, h4, .font-bold, .font-semibold, .text-label-md');
  var title = card.dataset.flipTitle || (titleNode && titleNode.textContent.trim()) || 'карточки';
  card.dataset.flipTitle = title;
  card.classList.toggle('is-flipped', expanded);
  card.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  card.setAttribute('aria-label', (expanded ? 'Скрыть пример: ' : 'Показать пример: ') + title);
  if (front) front.setAttribute('aria-hidden', expanded ? 'true' : 'false');
  if (back) back.setAttribute('aria-hidden', expanded ? 'false' : 'true');
}

  // Income steps — animate arrows on scroll
  var incomeSteps = document.querySelector('.income-steps');
  if (incomeSteps) {
    var stepsObserver = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          stepsObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.3 });
    stepsObserver.observe(incomeSteps);
  }
