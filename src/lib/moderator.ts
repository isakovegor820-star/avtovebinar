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
  const topic = session.title?.trim() ? `Тема эфира: «${session.title.trim()}». ` : '';
  return (
    'Добро пожаловать на вебинар АСПБ! 👋 Я модератор и веду этот чат. ' +
    topic +
    'Разбираем, как юристу законно и системно зарабатывать на кризисных ситуациях бизнеса: ' +
    'находить клиентов, передавать сложные кейсы арбитражным управляющим АСПБ и получать ' +
    'вознаграждение по договору. Пишите вопросы прямо в чат — на то, что спикер не успеет ' +
    'разобрать в эфире, отвечу здесь я.'
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
    kind: MODERATOR_CHAT_KIND,
    authorName: MODERATOR_NAME,
    authorRole: MODERATOR_ROLE,
    message: buildModeratorIntroText(session),
  };
}
