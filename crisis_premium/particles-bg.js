(function() {
  // Тяжёлый фон (3150 частиц в бесконечном rAF) НЕ запускаем на тач-устройствах и при
  // reduced-motion: на телефоне это давало джанк, нагрев и расход батареи, а привязка
  // height=innerHeight вызывала «прыжки» фона при появлении/скрытии адресной строки iOS.
  // На десктопе с мышью — работает как прежде.
  try {
    if (window.matchMedia && (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      window.matchMedia('(hover: none)').matches ||
      window.matchMedia('(pointer: coarse)').matches
    )) {
      return;
    }
  } catch (e) { /* matchMedia недоступен — продолжаем как обычно */ }

  var canvas = document.createElement('canvas');
  canvas.id = 'particlesBg';
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:-1;pointer-events:none;';
  document.body.prepend(canvas);

  var ctx = canvas.getContext('2d');
  var width, height, mouse, time;
  var COLS = 70;
  var ROWS = 45;
  var TOTAL = COLS * ROWS;

  mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };

  // Simple noise
  var perm = [];
  for (var i = 0; i < 512; i++) perm[i] = (Math.random() * 256) | 0;

  function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function lerp(a, b, t) { return a + t * (b - a); }

  function noise2d(x, y) {
    var xi = (x | 0) & 255, yi = (y | 0) & 255;
    var xf = x - (x | 0), yf = y - (y | 0);
    var u = fade(xf), v = fade(yf);
    var aa = perm[perm[xi] + yi] || 0;
    var ab = perm[perm[xi] + yi + 1] || 0;
    var ba = perm[perm[xi + 1] + yi] || 0;
    var bb = perm[perm[xi + 1] + yi + 1] || 0;
    return lerp(
      lerp(((aa % 8) - 4) / 4 * xf + ((aa % 4) - 2) / 2 * yf,
           ((ba % 8) - 4) / 4 * (xf - 1) + ((ba % 4) - 2) / 2 * yf, u),
      lerp(((ab % 8) - 4) / 4 * xf + ((ab % 4) - 2) / 2 * (yf - 1),
           ((bb % 8) - 4) / 4 * (xf - 1) + ((bb % 4) - 2) / 2 * (yf - 1), u),
      v
    );
  }

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }

  function animate() {
    time = Date.now() * 0.0003;

    mouse.x += (mouse.tx - mouse.x) * 0.03;
    mouse.y += (mouse.ty - mouse.y) * 0.03;

    ctx.clearRect(0, 0, width, height);

    var spacingX = width / COLS;
    var spacingY = height / ROWS;

    for (var i = 0; i < TOTAL; i++) {
      var col = i % COLS;
      var row = (i / COLS) | 0;

      var baseX = col * spacingX + spacingX * 0.5;
      var baseY = row * spacingY + spacingY * 0.5;

      var nx = col / COLS;
      var ny = row / ROWS;

      var n1 = noise2d(nx * 3 + time, ny * 2 + time * 0.7);
      var n2 = noise2d(nx * 2 - time * 0.5, ny * 3 + time * 0.3);

      var wave = Math.sin(nx * 5 + time * 2 + ny * 2) * 15;
      var wave2 = Math.cos(ny * 4 + time * 1.5 + nx * 3) * 12;

      var mdx = nx - mouse.x;
      var mdy = ny - mouse.y;
      var mDist = Math.sqrt(mdx * mdx + mdy * mdy);
      var mForce = Math.max(0, 1 - mDist / 0.25);
      var mouseOffX = mdx * mForce * 30;
      var mouseOffY = mdy * mForce * 30;

      var px = baseX + n1 * 20 + wave + mouseOffX;
      var py = baseY + n2 * 18 + wave2 + mouseOffY;

      var depth = (Math.sin(nx * 4 + time + ny * 2) + 1) * 0.5;
      var size = 0.6 + depth * 1.2;
      var alpha = 0.08 + depth * 0.18;

      var hue = 215 + n1 * 20;

      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fillStyle = 'hsla(' + hue + ', 60%, 55%, ' + alpha + ')';
      ctx.fill();
    }

    requestAnimationFrame(animate);
  }

  document.addEventListener('mousemove', function(e) {
    mouse.tx = e.clientX / width;
    mouse.ty = e.clientY / height;
  });

  window.addEventListener('resize', resize);

  resize();
  animate();
})();
