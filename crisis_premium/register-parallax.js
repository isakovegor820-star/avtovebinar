const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

window.addEventListener('scroll', () => {
  if (prefersReducedMotion) return;
  const logo = document.querySelector('.text-headline-md');
  if (!logo) return;

  logo.style.transform = window.pageYOffset > 50 ? 'scale(0.95)' : 'scale(1)';
});
