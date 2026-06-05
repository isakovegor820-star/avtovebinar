#!/bin/bash
set -e

DIR="crisis_premium/assets"
TMP="${DIR}/tmp_build"
mkdir -p "$TMP"

echo "🎬 Создаём слайды автовебинара АСПБ..."

# ─── Создаём PNG-слайды через SVG ───

create_slide() {
  local name="$1" bg="$2" svg_body="$3"
  cat > "$TMP/${name}.svg" << SVGEOF
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="${bg}"/>
  <!-- ASPB logo -->
  <text x="80" y="65" font-family="Helvetica,Arial,sans-serif" font-size="28" font-weight="bold" fill="#7A8EA6">ASPБ</text>
  <text x="135" y="65" font-family="Helvetica,Arial,sans-serif" font-size="14" fill="#4A5E76">Антикризисная служба</text>
  ${svg_body}
</svg>
SVGEOF
  # Convert SVG → PNG using qlmanage (macOS built-in)
  qlmanage -t -s 1920 -o "$TMP" "$TMP/${name}.svg" 2>/dev/null || \
    cp "$TMP/${name}.svg" "$TMP/${name}.svg.png" 2>/dev/null
}

# Слайд 1: Приветствие (0:00 - 4:59)
echo "  [1/7] Приветствие..."
create_slide "s1" "#0A1628" '
  <text x="960" y="280" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="62" font-weight="bold" fill="white">Экономика кризиса</text>
  <text x="960" y="350" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="36" fill="#BCC7DD">Как зарабатывать на защите</text>
  <text x="960" y="400" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="36" fill="#BCC7DD">финансовых прав бизнеса</text>
  <rect x="760" y="460" width="400" height="3" rx="2" fill="#FED488"/>
  <text x="960" y="530" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="24" fill="#FED488">Клиенты с долгами уже проходят через вас</text>
  <text x="960" y="580" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="20" fill="#7A8EA6">Подготовьте пример клиента для разбора</text>
'

# Слайд 2: Проблема (5:00 - 12:59)
echo "  [2/7] Проблема..."
create_slide "s2" "#0D1E35" '
  <text x="960" y="260" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="58" font-weight="bold" fill="white">Бизнес закрывается тише</text>
  <text x="960" y="340" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="58" font-weight="bold" fill="#FED488">чем кажется</text>
  <rect x="760" y="390" width="400" height="3" rx="2" fill="#FED488" opacity="0.4"/>
  <text x="960" y="470" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="26" fill="#BCC7DD">Проблемы видны не в новостях,</text>
  <text x="960" y="510" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="26" fill="#BCC7DD">а в платежах, блокировках, налогах</text>
  <text x="960" y="550" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="26" fill="#BCC7DD">и просьбах «потянуть ещё немного»</text>
  <rect x="300" y="650" width="1320" height="60" rx="12" fill="#FED488" opacity="0.15"/>
  <text x="960" y="690" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="22" fill="#FED488">Узнали свою ситуацию? Задайте вопрос!</text>
'

# Слайд 3: Карта клиентов (13:00 - 25:59)
echo "  [3/7] Карта клиентов..."
create_slide "s3" "#0A1628" '
  <text x="960" y="200" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="50" font-weight="bold" fill="white">Карта проблемных клиентов</text>
  <rect x="300" y="280" width="1320" height="520" rx="16" fill="#0D1E35"/>
  <circle cx="370" cy="350" r="24" fill="#FED488" opacity="0.3"/>
  <text x="410" y="345" font-family="Helvetica,Arial,sans-serif" font-size="30" font-weight="bold" fill="#FED488">Бухгалтеры</text>
  <text x="410" y="380" font-family="Helvetica,Arial,sans-serif" font-size="22" fill="#BCC7DD">видят долги по налогам и кредитам</text>
  <circle cx="370" cy="450" r="24" fill="#FED488" opacity="0.3"/>
  <text x="410" y="445" font-family="Helvetica,Arial,sans-serif" font-size="30" font-weight="bold" fill="#FED488">Юристы</text>
  <text x="410" y="480" font-family="Helvetica,Arial,sans-serif" font-size="22" fill="#BCC7DD">видят иски, блокировки, угрозы банкротства</text>
  <circle cx="370" cy="550" r="24" fill="#FED488" opacity="0.3"/>
  <text x="410" y="545" font-family="Helvetica,Arial,sans-serif" font-size="30" font-weight="bold" fill="#FED488">Консультанты</text>
  <text x="410" y="580" font-family="Helvetica,Arial,sans-serif" font-size="22" fill="#BCC7DD">слышат «Помогите спасти бизнес»</text>
  <circle cx="370" cy="650" r="24" fill="#FED488" opacity="0.3"/>
  <text x="410" y="645" font-family="Helvetica,Arial,sans-serif" font-size="30" font-weight="bold" fill="#FED488">Риелторы</text>
  <text x="410" y="680" font-family="Helvetica,Arial,sans-serif" font-size="22" fill="#BCC7DD">видят сделки, которые срываются из-за долгов</text>
  <text x="960" y="870" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="22" fill="#7A8EA6">Все видят разные симптомы одной проблемы</text>
'

# Слайд 4: АСПБ (26:00 - 33:59)
echo "  [4/7] Кто такая АСПБ..."
create_slide "s4" "#0D1E35" '
  <text x="960" y="250" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="62" font-weight="bold" fill="white">Кто такая АСПБ</text>
  <rect x="760" y="290" width="400" height="3" rx="2" fill="#FED488"/>
  <text x="960" y="380" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="30" fill="#FED488">Антикризисная служба помощи бизнесу</text>
  <rect x="300" y="430" width="1320" height="70" rx="12" fill="#0A1628"/>
  <text x="960" y="475" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="26" fill="#BCC7DD">Диагностика → Документы → Суд → Кредиторы</text>
  <text x="960" y="580" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="48" font-weight="bold" fill="white">17 000+ успешных дел</text>
  <text x="960" y="650" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="24" fill="#7A8EA6">Опытные арбитражные управляющие</text>
'

# Слайд 5: Партнёрская модель (34:00 - 42:59)
echo "  [5/7] Партнёрская модель..."
create_slide "s5" "#0A1628" '
  <text x="960" y="230" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="58" font-weight="bold" fill="white">Партнёрская модель</text>
  <rect x="300" y="320" width="1320" height="160" rx="16" fill="#0D1E35"/>
  <text x="960" y="380" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="32" font-weight="bold" fill="#FED488">Вы НЕ ведёте процедуру</text>
  <text x="960" y="430" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="32" font-weight="bold" fill="#FED488">Вы НЕ берёте на себя суды</text>
  <text x="960" y="560" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="42" font-weight="bold" fill="white">Ваша роль — точка входа</text>
  <text x="960" y="620" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="26" fill="#BCC7DD">Направляете клиента в систему АСПБ</text>
  <rect x="350" y="700" width="1220" height="56" rx="28" fill="#FED488" opacity="0.15"/>
  <text x="960" y="738" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="22" fill="#FED488">Посмотрите путь партнёра</text>
'

# Слайд 6: Договор (43:00 - 54:59)
echo "  [6/7] Деньги и договор..."
create_slide "s6" "#0D1E35" '
  <text x="960" y="250" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="58" font-weight="bold" fill="white">Деньги и договор</text>
  <rect x="760" y="290" width="400" height="3" rx="2" fill="#FED488"/>
  <text x="960" y="380" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="28" fill="#BCC7DD">Условия фиксируются партнёрским договором</text>
  <text x="960" y="450" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="28" fill="#BCC7DD">Проблемный клиент больше не уходит</text>
  <text x="960" y="500" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="28" fill="#FED488">без результата</text>
  <text x="960" y="600" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="22" fill="#7A8EA6">Не нужно быть банкротным юристом</text>
  <text x="960" y="640" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="22" fill="#7A8EA6">Достаточно предложить диагностику</text>
  <rect x="300" y="720" width="1320" height="60" rx="30" fill="#FED488" opacity="0.2"/>
  <text x="960" y="760" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="24" font-weight="bold" fill="#FED488">Оставьте заявку на партнёрский договор</text>
'

# Слайд 7: Финальный CTA (55:00 - 60:00)
echo "  [7/7] Финальный CTA..."
create_slide "s7" "#041627" '
  <text x="960" y="300" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="62" font-weight="bold" fill="white">Вы узнали своих клиентов?</text>
  <text x="960" y="430" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="36" fill="#BCC7DD">Оставьте заявку на</text>
  <text x="960" y="500" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="52" font-weight="bold" fill="#FED488">ПАРТНЁРСКИЙ ДОГОВОР</text>
  <text x="960" y="610" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="26" fill="#BCC7DD">Менеджер АСПБ покажет,</text>
  <text x="960" y="650" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="26" fill="#BCC7DD">как передавать клиентов в работу</text>
  <rect x="600" y="740" width="720" height="70" rx="35" fill="#FED488"/>
  <text x="960" y="785" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="26" font-weight="bold" fill="#041627">НАЖМИТЕ КНОПКУ НИЖЕ</text>
'

echo ""
echo "🖼  Конвертируем SVG → PNG..."

for f in "$TMP"/s*.svg; do
  base=$(basename "$f" .svg)
  # Use rsvg-convert if available, otherwise try python or sips
  if command -v rsvg-convert &>/dev/null; then
    rsvg-convert -w 1920 -h 1080 "$f" -o "$TMP/${base}.png"
  elif python3 -c "import cairosvg" 2>/dev/null; then
    python3 -c "import cairosvg; cairosvg.svg2png(url='$f', write_to='$TMP/${base}.png', output_width=1920, output_height=1080)"
  else
    # Use sips with intermediate step — sips can't do SVG so we'll use the SVG directly with ffmpeg
    cp "$f" "$TMP/${base}.png.svg"
  fi
done

echo "🎬 Генерируем видео из слайдов..."

# Durations for each section (seconds)
DURS=(300 480 780 480 540 720 300)
NAMES=(s1 s2 s3 s4 s5 s6 s7)

# Check if we have PNGs or SVGs
if [ -f "$TMP/s1.png" ]; then
  EXT="png"
  INPUT_FMT="-loop 1 -i"
else
  # Fallback: use ffmpeg with SVG input (ffmpeg can read SVG if librsvg is available)
  EXT="svg"
  INPUT_FMT="-loop 1 -i"
fi

for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  dur="${DURS[$i]}"
  echo "  [$(($i+1))/7] ${name} → ${dur}s видео..."
  
  if [ -f "$TMP/${name}.png" ]; then
    ffmpeg -y -loop 1 -framerate 1 -i "$TMP/${name}.png" \
      -f lavfi -i "anullsrc=r=44100:cl=stereo" \
      -c:v libx264 -preset ultrafast -crf 28 -r 1 -pix_fmt yuv420p \
      -c:a aac -b:a 128k \
      -t "$dur" \
      "$TMP/${name}_video.mp4" 2>/dev/null
  else
    # SVG fallback using ffmpeg's SVG decoder
    ffmpeg -y -loop 1 -framerate 1 -i "$TMP/${name}.svg" \
      -f lavfi -i "anullsrc=r=44100:cl=stereo" \
      -c:v libx264 -preset ultrafast -crf 28 -r 1 -pix_fmt yuv420p \
      -vf "scale=1920:1080" \
      -c:a aac -b:a 128k \
      -t "$dur" \
      "$TMP/${name}_video.mp4" 2>/dev/null
  fi
done

echo ""
echo "🔗 Склеиваем 7 секций в один файл..."

cat > "$TMP/list.txt" << EOF
file 's1_video.mp4'
file 's2_video.mp4'
file 's3_video.mp4'
file 's4_video.mp4'
file 's5_video.mp4'
file 's6_video.mp4'
file 's7_video.mp4'
EOF

ffmpeg -y -f concat -safe 0 -i "$TMP/list.txt" -c copy "${DIR}/webinar.mp4" 2>/dev/null

echo ""
echo "🧹 Очистка временных файлов..."
rm -rf "$TMP"

echo ""
echo "✅ Автовебинар создан: ${DIR}/webinar.mp4"
echo "📏 Размер: $(du -h "${DIR}/webinar.mp4" | cut -f1)"
echo "⏱  Длительность: 60 минут"
echo ""
echo "📋 Таймлайн:"
echo "  00:00-04:59 — Приветствие: Экономика кризиса"
echo "  05:00-12:59 — Бизнес закрывается тише чем кажется"
echo "  13:00-25:59 — Карта проблемных клиентов"
echo "  26:00-33:59 — Кто такая АСПБ (17 000+ дел)"
echo "  34:00-42:59 — Партнёрская модель"
echo "  43:00-54:59 — Деньги и договор"
echo "  55:00-60:00 — Финальный CTA: Оставьте заявку"
