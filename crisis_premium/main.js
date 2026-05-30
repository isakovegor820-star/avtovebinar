(function(){
  const observer = new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      if(entry.isIntersecting){
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  },{threshold:0.15});
  document.querySelectorAll('.card-reveal').forEach(function(el){observer.observe(el);});

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
          el.textContent = currentDisplay + suffix;
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
})();


  // Auto-flip first card as hint
  var flipCards = document.querySelectorAll('.flip-card');
  if (flipCards.length > 0) {
    var flipObserver = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          flipObserver.unobserve(entry.target);
          // Auto-flip after 3 seconds
          setTimeout(function() {
            entry.target.classList.add('is-flipped');
            // Flip back after 2.5 seconds
            setTimeout(function() {
              entry.target.classList.remove('is-flipped');
            }, 2500);
          }, 3000);
        }
      });
    }, { threshold: 0.5 });

    // Observe only the first flip-card in each group
    var observed = new Set();
    flipCards.forEach(function(card) {
      var parent = card.parentElement;
      if (!observed.has(parent)) {
        observed.add(parent);
        flipObserver.observe(card);
      }
    });
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
