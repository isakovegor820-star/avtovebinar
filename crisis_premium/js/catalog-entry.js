import { getJson } from './utils.js';

getJson('/v1/catalog/practice-areas')
  .then(() => {
    document.querySelectorAll('[data-catalog-link]').forEach(link => {
      link.hidden = false;
    });
  })
  .catch(() => {
    // При выключенном rollout-флаге legacy-воронка остаётся без новой ссылки.
  });
