document.addEventListener('DOMContentLoaded', () => {
  const card = document.querySelector('.glass-card');
  if (!card) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  card.style.opacity = '0';
  card.style.transform = 'translateY(20px)';

  setTimeout(() => {
    card.style.transition = 'all 0.8s cubic-bezier(0.16, 1, 0.3, 1)';
    card.style.opacity = '1';
    card.style.transform = 'translateY(0)';
  }, 100);
});
