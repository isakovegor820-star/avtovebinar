/**
 * Live Chat — автоматические сообщения синхронизированные с видео.
 * Создаёт эффект живого эфира с участниками.
 */
(function() {
  var chatContainer = document.getElementById('liveChatMessages');
  var video = document.getElementById('webinarVideo');
  if (!chatContainer || !video) return;

  // Автосообщения — привязаны к секундам видео
  var AUTO_MESSAGES = [
    { time: 5, name: 'Модератор', icon: 'support_agent', color: '#041627', text: 'Добро пожаловать на эфир АСПБ! Задавайте вопросы в чате.' },
    { time: 15, name: 'Алексей К.', icon: null, text: 'Добрый день! Подключился из Москвы.' },
    { time: 25, name: 'Ирина В.', icon: null, text: 'Привет всем! Юрист, 8 лет практики.' },
    { time: 45, name: 'Дмитрий Р.', icon: null, text: 'Интересная тема, давно хотел разобраться.' },
    { time: 70, name: 'Модератор', icon: 'support_agent', color: '#041627', text: 'Напоминаю: вопросы можно задавать прямо в чате. Спикер ответит в конце.' },
    { time: 100, name: 'Марина С.', icon: null, text: 'У меня клиент с долгом 3 млн, ФНС давит. Это подходит?' },
    { time: 120, name: 'Модератор', icon: 'support_agent', color: '#041627', text: 'Марина, да — именно такие ситуации разберём. Оставайтесь до конца.' },
    { time: 155, name: 'Олег Н.', icon: null, text: 'А если клиент ИП и хочет закрыться с долгами?' },
    { time: 180, name: 'Анна Л.', icon: null, text: 'Подскажите, субсидиарка тоже входит в работу АСПБ?' },
    { time: 210, name: 'Модератор', icon: 'support_agent', color: '#041627', text: 'Олег, Анна — да, оба случая. Подробности будут через пару минут.' },
    { time: 240, name: 'Сергей М.', icon: null, text: 'Я из Новосибирска. АСПБ работает по регионам?' },
    { time: 270, name: 'Модератор', icon: 'support_agent', color: '#041627', text: 'Сергей — да, вся РФ. Процедура дистанционная.' },
    { time: 300, name: 'Елена Т.', icon: null, text: 'Очень полезно! Записываю.' },
    { time: 330, name: 'Виктор А.', icon: null, text: 'А какой процент вознаграждения для партнёра?' },
    { time: 365, name: 'Модератор', icon: 'support_agent', color: '#041627', text: 'Виктор — условия фиксируются в договоре. После эфира можно оставить заявку.' },
    { time: 400, name: 'Наталья К.', icon: null, text: 'У меня 3 таких клиента за последний месяц было. Жаль что раньше не знала.' },
    { time: 440, name: 'Игорь Б.', icon: null, text: 'Вопрос: нужно ли мне самому разбираться в банкротстве?' },
    { time: 470, name: 'Модератор', icon: 'support_agent', color: '#041627', text: 'Игорь — нет. Вы только передаёте контакт, всё остальное делает команда АСПБ.' },
    { time: 505, name: 'Алексей К.', icon: null, text: 'Отличный формат. Буду оставлять заявку.' },
    { time: 530, name: 'Марина С.', icon: null, text: 'Спасибо за эфир! Очень конкретно и по делу.' },
    { time: 550, name: 'Модератор', icon: 'support_agent', color: '#041627', text: 'Спасибо всем! Не забудьте оставить заявку на партнёрский договор ниже.' }
  ];

  var shownMessages = new Set();
  var COLORS = ['#1e40af', '#7c3aed', '#0f766e', '#b45309', '#be123c', '#4338ca'];

  function getInitials(name) {
    return name.split(' ').map(function(w) { return w[0]; }).join('').substring(0, 2);
  }

  function getColor(name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return COLORS[Math.abs(hash) % COLORS.length];
  }

  function addMessage(msg) {
    var div = document.createElement('div');
    div.className = 'flex gap-2.5 chat-msg-enter';
    div.style.animation = 'chatMsgIn 0.3s ease forwards';

    var avatarColor = msg.color || getColor(msg.name);
    var avatarContent = msg.icon
      ? '<span class="material-symbols-outlined text-[14px]">' + msg.icon + '</span>'
      : '<span style="font-size:11px;font-weight:700">' + getInitials(msg.name) + '</span>';

    div.innerHTML =
      '<div style="width:28px;height:28px;border-radius:50%;background:' + avatarColor + ';color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0">' + avatarContent + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<span style="font-size:11px;font-weight:700;color:' + avatarColor + '">' + msg.name + '</span>' +
        '<p style="font-size:13px;color:#44474c;line-height:1.4;margin:2px 0 0;word-wrap:break-word">' + msg.text + '</p>' +
      '</div>';

    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function checkMessages() {
    var currentTime = video.currentTime;
    for (var i = 0; i < AUTO_MESSAGES.length; i++) {
      var msg = AUTO_MESSAGES[i];
      if (!shownMessages.has(i) && currentTime >= msg.time) {
        shownMessages.add(i);
        addMessage(msg);
      }
    }
  }

  // Check every 500ms
  setInterval(checkMessages, 500);

  // Also handle user's own question submission
  var input = document.getElementById('questionInput');
  var submitBtn = document.getElementById('questionSubmit');
  if (input && submitBtn) {
    function sendQuestion() {
      var text = input.value.trim();
      if (!text) return;
      addMessage({ name: 'Вы', icon: 'person', color: '#041627', text: text });
      input.value = '';
    }
    submitBtn.addEventListener('click', sendQuestion);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') sendQuestion();
    });
  }
})();
