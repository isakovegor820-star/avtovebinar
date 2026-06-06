export type ScriptedChatMessage = {
  id: string;
  offsetSeconds: number;
  authorName: string;
  authorRole: string;
  authorCity: string;
  message: string;
  kind: 'scripted_user' | 'agent_question';
  isSynthetic: true;
  videoBlock: string;
};

export const SCRIPTED_CHAT_MESSAGES: ScriptedChatMessage[] = [
  // ── Блок 0-1. Старт эфира ──────────────────────────────────────
  {
    id: 'scripted_001',
    offsetSeconds: 8,
    authorName: 'Марина',
    authorRole: 'юрист',
    authorCity: 'Москва',
    message: 'Коллеги, добрый день. Интересно, как это применять именно в юридической практике.',
    kind: 'scripted_user',
    isSynthetic: true,
    videoBlock: 'Старт эфира',
  },
  {
    id: 'scripted_002',
    offsetSeconds: 24,
    authorName: 'Игорь',
    authorRole: 'адвокат',
    authorCity: 'Казань',
    message: 'Тема актуальная, клиенты с долгами стали приходить чаще.',
    kind: 'scripted_user',
    isSynthetic: true,
    videoBlock: 'Старт эфира',
  },

  // ── Агент-вопрос → Блок 2: сигналы долгового клиента ──────────
  {
    id: 'scripted_003',
    offsetSeconds: 75,
    authorName: 'Елена',
    authorRole: 'налоговый консультант',
    authorCity: 'Екатеринбург',
    message: 'Если у клиента уже блокировка счета по налогам, это тоже тот самый сигнал?',
    kind: 'agent_question',
    isSynthetic: true,
    videoBlock: 'Сигналы долгового клиента',
  },

  {
    id: 'scripted_004',
    offsetSeconds: 105,
    authorName: 'Дмитрий',
    authorRole: 'юрист',
    authorCity: 'Новосибирск',
    message: 'Согласен про риск отпустить клиента. Обычно после консультации он уходит искать решение сам.',
    kind: 'scripted_user',
    isSynthetic: true,
    videoBlock: 'Проблема потери клиента',
  },

  // ── Агент-вопрос → Блок 6: безопасная коммуникация с клиентом ─
  {
    id: 'scripted_005',
    offsetSeconds: 135,
    authorName: 'Антон',
    authorRole: 'финансовый консультант',
    authorCity: 'Самара',
    message: 'А как корректно говорить с клиентом, чтобы не обещать ему невозможного?',
    kind: 'agent_question',
    isSynthetic: true,
    videoBlock: 'Безопасная коммуникация',
  },

  // ── Агент-вопрос → Блок 5: что берёт на себя АСПБ ────────────
  {
    id: 'scripted_006',
    offsetSeconds: 190,
    authorName: 'Ольга',
    authorRole: 'юрист',
    authorCity: 'Ростов-на-Дону',
    message: 'Правильно понимаю, что документы и процедуру берет на себя команда АСПБ?',
    kind: 'agent_question',
    isSynthetic: true,
    videoBlock: 'Что берет на себя АСПБ',
  },

  {
    id: 'scripted_007',
    offsetSeconds: 220,
    authorName: 'Марина',
    authorRole: 'юрист',
    authorCity: 'Москва',
    message: 'Для партнеров важно, чтобы не пришлось самим вести банкротство. Это как раз боль.',
    kind: 'scripted_user',
    isSynthetic: true,
    videoBlock: 'Роль партнера',
  },

  {
    id: 'scripted_008',
    offsetSeconds: 265,
    authorName: 'Сергей',
    authorRole: 'арбитражный юрист',
    authorCity: 'Пермь',
    message: 'Есть кейсы, где клиент боится слова банкротство. Диагностика звучит спокойнее.',
    kind: 'scripted_user',
    isSynthetic: true,
    videoBlock: 'Диагностика вместо давления',
  },

  // ── Агент-вопрос → Блок 6: когда передавать клиента ───────────
  {
    id: 'scripted_009',
    offsetSeconds: 325,
    authorName: 'Елена',
    authorRole: 'налоговый консультант',
    authorCity: 'Екатеринбург',
    message: 'Про ФНС и кредиторов очень узнаваемо. А когда уже пора передавать клиента дальше?',
    kind: 'agent_question',
    isSynthetic: true,
    videoBlock: 'Когда передавать клиента',
  },

  // ── Агент-вопрос → Блок 6: типы клиентов (ИП vs юрлицо) ──────
  {
    id: 'scripted_010',
    offsetSeconds: 355,
    authorName: 'Игорь',
    authorRole: 'адвокат',
    authorCity: 'Казань',
    message: 'Если клиент ИП, маршрут отличается от юрлица или сначала все равно диагностика?',
    kind: 'agent_question',
    isSynthetic: true,
    videoBlock: 'Типы клиентов',
  },

  {
    id: 'scripted_011',
    offsetSeconds: 390,
    authorName: 'Дмитрий',
    authorRole: 'юрист',
    authorCity: 'Новосибирск',
    message: 'Условия партнерства фиксируются договором - это правильно, без устных договоренностей спокойнее.',
    kind: 'scripted_user',
    isSynthetic: true,
    videoBlock: 'Партнерская модель',
  },

  // ── Агент-вопрос → Блок 7: вознаграждение партнера ────────────
  {
    id: 'scripted_014',
    offsetSeconds: 415,
    authorName: 'Сергей',
    authorRole: 'арбитражный юрист',
    authorCity: 'Пермь',
    message: 'Подскажите, а когда фиксируется партнерское вознаграждение — сразу при передаче клиента?',
    kind: 'agent_question',
    isSynthetic: true,
    videoBlock: 'Вознаграждение партнера',
  },

  {
    id: 'scripted_012',
    offsetSeconds: 450,
    authorName: 'Ольга',
    authorRole: 'юрист',
    authorCity: 'Ростов-на-Дону',
    message: 'Вспомнила двух клиентов за май: долги, кредиторы и просроченные налоги.',
    kind: 'scripted_user',
    isSynthetic: true,
    videoBlock: 'Вопрос участникам',
  },

  // ── Агент-вопрос → Блок 8: возражение "я не юрист" ───────────
  {
    id: 'scripted_015',
    offsetSeconds: 472,
    authorName: 'Марина',
    authorRole: 'бухгалтер',
    authorCity: 'Краснодар',
    message: 'Я бухгалтер, а не юрист. Мне вообще можно участвовать в партнерстве?',
    kind: 'agent_question',
    isSynthetic: true,
    videoBlock: 'Возражения перед стартом',
  },

  {
    id: 'scripted_013',
    offsetSeconds: 510,
    authorName: 'Антон',
    authorRole: 'финансовый консультант',
    authorCity: 'Самара',
    message: 'После эфира оставлю заявку, хочу понять формат передачи клиентов.',
    kind: 'scripted_user',
    isSynthetic: true,
    videoBlock: 'Финальный шаг',
  },

  // ── Агент-вопрос → Блок 9: удалённая работа ──────────────────
  {
    id: 'scripted_016',
    offsetSeconds: 540,
    authorName: 'Игорь',
    authorRole: 'адвокат',
    authorCity: 'Казань',
    message: 'Можно ли работать с АСПБ удаленно, из другого города?',
    kind: 'agent_question',
    isSynthetic: true,
    videoBlock: 'Финальный CTA',
  },
];

export function getScriptedChatMessagesUntil(offsetSeconds: number) {
  return SCRIPTED_CHAT_MESSAGES.filter(message => message.offsetSeconds <= offsetSeconds);
}
