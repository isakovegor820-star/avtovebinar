import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

function readProjectFile(path: string) {
  return readFileSync(join(projectRoot, path), 'utf8');
}

function html(name: string) {
  return readProjectFile(`crisis_premium/${name}`);
}

describe('interface remediation regressions', () => {
  const landing = html('index.html');
  const registration = html('register.html');
  const admin = html('admin.html');
  const landingMain = readProjectFile('crisis_premium/main.js');
  const landingInteractions = readProjectFile('crisis_premium/landing-interactions.js');
  const registrationParallax = readProjectFile('crisis_premium/register-parallax.js');
  const premiumButtons = readProjectFile('crisis_premium/buttons.js');
  const successAnimation = readProjectFile('crisis_premium/success-animation.js');

  it('keeps the full landing navigation out of the 768px tablet breakpoint', () => {
    expect(landing).toContain('class="hidden lg:flex items-center gap-8"');
    expect(landing).toContain('class="lg:hidden px-gutter pb-3"');
  });

  it('implements the APG tabs relationships, roving tabindex and keyboard controls', () => {
    expect(landing).toContain(
      'id="regScaleTab1" class="seg-tab seg-tab--active" role="tab" aria-selected="true" aria-controls="regScalePanel"',
    );
    expect(landing).toContain(
      'id="regScalePanel" role="tabpanel" aria-labelledby="regScaleTab1" tabindex="0"',
    );
    expect(landing).toContain('id="incomeTab1" aria-controls="incomeDetail" aria-selected="false"');
    expect(landing).toContain('id="incomeTab2" aria-controls="incomeDetail" aria-selected="true"');
    expect(landing).toContain('id="incomeDetail" role="tabpanel" aria-labelledby="incomeTab2" tabindex="0"');
    expect(landingMain).toContain("if (event.key === 'ArrowRight')");
    expect(landingMain).toContain("if (event.key === 'ArrowLeft')");
    expect(landingMain).toContain("if (event.key === 'Home')");
    expect(landingMain).toContain("if (event.key === 'End')");
    expect(landingMain).toContain("candidate.setAttribute('tabindex', selected ? '0' : '-1')");
    expect(landingInteractions).toContain("if (event.key === 'ArrowRight' || event.key === 'ArrowDown')");
    expect(landingInteractions).toContain("if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')");
    expect(landingInteractions).toContain("item.setAttribute('tabindex', selected ? '0' : '-1')");
  });

  it('programmatically names the participant radio group', () => {
    expect(registration).toMatch(
      /<fieldset class="space-y-4">\s*<legend[^>]*>Есть ли сейчас клиенты[\s\S]*?name="clients"[\s\S]*?<\/fieldset>/,
    );
  });

  it('keeps the ticking landing countdown out of a live region', () => {
    const countdownTag = landing.match(/<div[^>]+id="heroCountdown"[^>]*>/)?.[0] ?? '';
    expect(countdownTag).toContain('role="timer"');
    expect(countdownTag).not.toContain('aria-live');
  });

  it('gives every audited admin control a persistent visible label', () => {
    const labelledIds = [
      'newUserName',
      'newUserEmail',
      'newUserPassword',
      'newUserRole',
      'funnelFrom',
      'funnelTo',
      'funnelAttribution',
      'queryInput',
      'dateInput',
      'statusFilter',
      'managerFilter',
      'telegramFilter',
      'roomFilter',
      'questionFilter',
      'applicationFilter',
      'broadcastText',
    ];
    for (const id of labelledIds) {
      expect(admin, id).toMatch(new RegExp(`<label[^>]+for="${id}"`));
    }
  });

  it('uses opaque semantic text colors for small supporting copy', () => {
    expect(landing).not.toContain('text-on-surface-variant/70');
    expect(registration).not.toContain('text-outline leading-relaxed');
    expect(registration).toContain('text-on-surface-variant leading-relaxed');
  });

  it('hides every static Material Symbols glyph from the accessibility tree', () => {
    const pages = readdirSync(join(projectRoot, 'crisis_premium')).filter(name => name.endsWith('.html'));
    for (const page of pages) {
      const symbols = html(page).match(/<span\b[^>]*\bclass="[^"]*\bmaterial-symbols-outlined\b[^"]*"[^>]*>/g) ?? [];
      for (const symbol of symbols) {
        expect(symbol, `${page}: ${symbol}`).toContain('aria-hidden="true"');
      }
    }
  });

  it('uses only ligatures that exist in the self-hosted Material Symbols subset', () => {
    const pages = readdirSync(join(projectRoot, 'crisis_premium')).filter(name => name.endsWith('.html'));
    const staticMarkup = pages.map(html).join('\n');
    for (const missingLigature of ['wifi_off', 'closed_caption', 'library_books', 'list_alt']) {
      expect(staticMarkup, missingLigature).not.toMatch(
        new RegExp(`material-symbols-outlined[^>]*>\\s*${missingLigature}\\s*<`),
      );
    }
  });

  it('offers bypass links on every repeated public funnel header', () => {
    const expectations: Record<string, string> = {
      'index.html': '#mainContent',
      'register.html': '#registerMain',
      'access.html': '#accessMain',
      'recordings.html': '#recordingsMain',
      'success.html': '#successPrimary',
      'webinar.html': '#mainContent',
    };
    for (const [page, target] of Object.entries(expectations)) {
      expect(html(page), page).toContain(`href="${target}"`);
    }
    expect(admin).toContain('class="admin-skip-link" href="#adminMain"');
    expect(readProjectFile('crisis_premium/css/input.css')).toContain('.platform-skip-link:focus-visible');
  });

  it('keeps technical English out of the corrected interface copy', () => {
    const allHtml = readdirSync(join(projectRoot, 'crisis_premium'))
      .filter(name => name.endsWith('.html'))
      .map(html)
      .join('\n');
    expect(allHtml).not.toMatch(/Session cookie|timezone каждой|Replay, часов|Разрешить replay|private Webinar|Готовим preview|Режим preview|Preview недоступен|platform admin|tenant-контекст/);
  });

  it('publishes fixed canonicals and keeps service states out of search results', () => {
    const publicCanonicals = [
      'index.html',
      'catalog.html',
      'privacy.html',
      'terms.html',
      'consent.html',
      'marketing-consent.html',
      'chat-rules.html',
    ];
    for (const page of publicCanonicals) {
      expect(html(page), page).toContain('name="robots" content="index, follow"');
      expect(html(page), page).toContain('rel="canonical"');
    }

    for (const page of ['access.html', 'account.html', 'admin.html', 'analytics.html', 'recordings.html', 'register.html', 'success.html', 'webinar.html']) {
      expect(html(page), page).toMatch(/name="robots" content="noindex, nofollow"/);
    }

    expect(html('landing.html')).toContain('name="robots" content="noindex, follow"');
    expect(html('landing.html')).toContain('rel="canonical" href="https://aspb-partners.ru/crisis_premium/index.html"');
    expect(html('catalog-webinar.html')).toContain('name="robots" content="index, follow"');
    expect(html('catalog-webinar.html')).not.toContain('rel="canonical"');

    const robots = readProjectFile('crisis_premium/robots.txt');
    expect(robots).toContain('Sitemap: https://aspb-partners.ru/sitemap.xml');
    expect(robots).toContain('Sitemap: https://aspb-partners.ru/sitemap-static.xml');
    const staticSitemap = readProjectFile('crisis_premium/sitemap-static.xml');
    expect(staticSitemap).toContain('/crisis_premium/index.html');
    expect(staticSitemap).toContain('/crisis_premium/privacy.html');
    expect(staticSitemap).not.toMatch(/register|success|admin|account/);
  });

  it('uses one production cache-busting version for the top-level participant module', () => {
    for (const page of ['index.html', 'register.html', 'access.html', 'success.html', 'recordings.html', 'webinar.html']) {
      expect(html(page), page).toContain('src="js/main.js?v=prelaunch-20260825-2"');
    }
    for (const module of ['main.js', 'analytics.js', 'registration.js', 'video.js', 'partner.js', 'room.js']) {
      const imports = readProjectFile(`crisis_premium/js/${module}`).match(/from ['"][^'"]+\?v=([^'"]+)['"]/g) ?? [];
      for (const imported of imports.filter(value => /(?:utils|analytics|registration|video|partner|room)\.js/.test(value))) {
        expect(imported, `${module}: ${imported}`).toContain('?v=prelaunch-20260825-2');
      }
    }
  });

  it('does not run the landing count-up and pointer tilt animations with reduced motion', () => {
    const inputCss = readProjectFile('crisis_premium/css/input.css');
    expect(landingMain).toContain("window.matchMedia('(prefers-reduced-motion: reduce)').matches");
    expect(landingMain).toContain('if (prefersReducedMotion) return;');
    expect(landingMain).toContain("display.replace('.', ',') + suffix");
    expect(landingInteractions).toContain("window.matchMedia?.('(prefers-reduced-motion: reduce)').matches");
    expect(registrationParallax).toContain("window.matchMedia?.('(prefers-reduced-motion: reduce)').matches");
    expect(premiumButtons).toContain("window.matchMedia?.('(prefers-reduced-motion: reduce)').matches");
    expect(successAnimation).toContain("window.matchMedia?.('(prefers-reduced-motion: reduce)').matches");
    expect(inputCss).toMatch(/prefers-reduced-motion:[^{]+\{[\s\S]*?\.bento-card-tilt\s*\{[\s\S]*?transform: none !important/);
  });
});
