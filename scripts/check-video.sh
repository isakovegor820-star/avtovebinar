#!/usr/bin/env bash
# Проверяет наличие видео для вебинарной комнаты.
# Если файла нет — выводит инструкцию.
# Запуск: bash scripts/check-video.sh

set -euo pipefail

VIDEO_PATH="crisis_premium/assets/webinar.mp4"
MIN_SIZE=1000000  # 1 MB minimum — pointer files are ~130 bytes

if [[ ! -f "$VIDEO_PATH" ]]; then
  echo "❌ Видео не найдено: $VIDEO_PATH"
  echo ""
  echo "Для работы вебинарной комнаты положите MP4-файл сюда:"
  echo "  $VIDEO_PATH"
  echo ""
  echo "Пример:"
  echo "  cp ~/Downloads/webinar.mp4 $VIDEO_PATH"
  exit 1
fi

FILE_SIZE=$(stat -f%z "$VIDEO_PATH" 2>/dev/null || stat --printf="%s" "$VIDEO_PATH" 2>/dev/null)

if [[ "$FILE_SIZE" -lt "$MIN_SIZE" ]]; then
  echo "⚠️  Файл $VIDEO_PATH слишком маленький ($FILE_SIZE байт)."
  echo "   Возможно это git-lfs pointer. Замените на реальное видео."
  exit 1
fi

echo "✅ Видео готово: $VIDEO_PATH ($(echo "scale=1; $FILE_SIZE/1048576" | bc) МБ)"
