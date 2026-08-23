import { env } from './env.js';

export const MODERATOR_NAME = env.MODERATOR_NAME;
export const MODERATOR_ROLE = env.MODERATOR_ROLE;
export const MODERATOR_CHAT_KIND = 'moderator';

// Стабильный id первого (закреплённого) сообщения модератора. Не зависит от сессии,
// чтобы клиент дедуплицировал его по renderKey и не дублировал при каждом опросе.
export const MODERATOR_INTRO_ID = 'moderator-intro';

type ModeratorIntroSession = {
  title?: string | null;
  scheduledAt: Date;
};

/**
 * Текст приветствия модератора. Описывает эфир и приглашает задавать вопросы,
 * подчёркивая, что модератор отвечает на то, что не разобрал спикер.
 */
export function buildModeratorIntroText(session: ModeratorIntroSession) {
  const topic = session.title?.trim() ? `Тема премьеры записи: «${session.title.trim()}». ` : '';
  return (
    'Добро пожаловать на вебинар АСПБ! ' +
    topic +
    'Чат модерируется командой организации. Подготовленные вопросы всегда отмечены отдельно. ' +
    'Ваш вопрос увидит модератор и при необходимости передаст автору.'
  );
}

/**
 * Закреплённое первое сообщение модератора. offsetSeconds=0 — никогда не отсекается
 * гейтом по позиции видео; visibleAt чуть раньше старта, чтобы всегда сортировалось первым.
 */
export function buildModeratorIntroMessage(session: ModeratorIntroSession) {
  return {
    id: MODERATOR_INTRO_ID,
    questionId: null as string | null,
    offsetSeconds: 0,
    visibleAt: new Date(session.scheduledAt.getTime() - 1000),
    kind: 'system' as const,
    authorName: 'Система АСПБ',
    authorRole: 'Системное сообщение',
    message: buildModeratorIntroText(session),
    isSynthetic: false as const,
  };
}
