/* cookie-consent.js — баннер согласия на cookies по 152-ФЗ / требованиям РКН.
 *
 * Показывается при первом заходе, пока выбор не сделан. Даёт РАВНОПРАВНЫЙ выбор
 * «Принять» / «Отклонить» и ссылку на Политику. Выбор хранится в cookie
 * aspb_cookie_consent (1 год). До «Принять» запускаются только технически
 * необходимые cookies; место для подключения метрик (Яндекс.Метрика и т.п.)
 * — функция loadOptionalServices(), вызывается только при согласии.
 *
 * Разметка строится через DOM API (без инлайн-стилей/скриптов) — совместимо с CSP.
 */
(function () {
  var CONSENT_COOKIE = 'aspb_cookie_consent';

  function getCookie(name) {
    var match = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return match ? match.pop() : '';
  }

  function setCookie(name, value, days) {
    var expires = new Date();
    expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
    var secure = location.protocol === 'https:' ? ';Secure' : '';
    document.cookie =
      name + '=' + value + ';expires=' + expires.toUTCString() + ';path=/;SameSite=Lax' + secure;
  }

  function hasDecision() {
    var value = getCookie(CONSENT_COOKIE);
    return value === 'accepted' || value === 'declined';
  }

  // Подключение необязательных сервисов (аналитика/пиксели) — ТОЛЬКО при согласии.
  // Сейчас таких сервисов нет; добавлять их инициализацию сюда.
  function loadOptionalServices() {
    /* пример: if (window.ym) ym(XXXXXX, 'init', {...}); */
  }

  function applyDecision(value) {
    setCookie(CONSENT_COOKIE, value, 365);
    if (value === 'accepted') {
      loadOptionalServices();
    }
  }

  function buildBanner() {
    var banner = document.createElement('div');
    banner.className = 'cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Уведомление об использовании cookie');

    var inner = document.createElement('div');
    inner.className = 'cookie-banner__inner';

    var text = document.createElement('div');
    text.className = 'cookie-banner__text';
    text.appendChild(
      document.createTextNode(
        'Мы используем cookie для работы сайта и улучшения сервиса. Нажимая «Принять», ' +
          'вы соглашаетесь на использование cookie. Подробнее — в ',
      ),
    );
    var link = document.createElement('a');
    link.href = 'privacy.html';
    link.textContent = 'Политике обработки персональных данных';
    text.appendChild(link);
    text.appendChild(document.createTextNode('.'));

    var actions = document.createElement('div');
    actions.className = 'cookie-banner__actions';

    var accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'cookie-banner__btn cookie-banner__btn--accept';
    accept.textContent = 'Принять';

    var decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'cookie-banner__btn cookie-banner__btn--decline';
    decline.textContent = 'Отклонить';

    function dismiss(value) {
      applyDecision(value);
      if (banner.parentNode) {
        banner.parentNode.removeChild(banner);
      }
    }

    accept.addEventListener('click', function () {
      dismiss('accepted');
    });
    decline.addEventListener('click', function () {
      dismiss('declined');
    });

    actions.appendChild(accept);
    actions.appendChild(decline);
    inner.appendChild(text);
    inner.appendChild(actions);
    banner.appendChild(inner);
    document.body.appendChild(banner);
  }

  function init() {
    if (hasDecision()) {
      if (getCookie(CONSENT_COOKIE) === 'accepted') {
        loadOptionalServices();
      }
      return;
    }
    buildBanner();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
