/* Site-wide behaviour: theme toggle, mobile navigation, service worker. */

const root = document.documentElement;
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function isDark() {
  const explicit = root.getAttribute('data-theme');
  return explicit ? explicit === 'dark' : darkQuery.matches;
}

function syncThemeButtons() {
  const dark = isDark();
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(dark));
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  });
}

document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
    syncThemeButtons();
  });
});
darkQuery.addEventListener?.('change', syncThemeButtons);
syncThemeButtons();

/* Mobile navigation */
const navToggle = document.querySelector('[data-nav-toggle]');
const nav = document.getElementById('site-nav');

function setNav(open) {
  if (!navToggle || !nav) return;
  nav.classList.toggle('is-open', open);
  navToggle.setAttribute('aria-expanded', String(open));
}

navToggle?.addEventListener('click', () => setNav(navToggle.getAttribute('aria-expanded') !== 'true'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && navToggle?.getAttribute('aria-expanded') === 'true') {
    setNav(false);
    navToggle.focus();
  }
});
document.addEventListener('click', (e) => {
  if (nav?.classList.contains('is-open') && !nav.contains(e.target) && !navToggle.contains(e.target)) setNav(false);
});

/* Offline support. Localhost is allowed so the preview server behaves like production. */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const base = root.dataset.base || '';
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${base}/sw.js`, { scope: `${base}/` }).catch(() => {});
  });
}
