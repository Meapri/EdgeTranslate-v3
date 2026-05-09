// Theme and page-theme management for PDF.js viewer (EdgeTranslate overlay)

const prefersDark = () => {
  try {
    const m = matchMedia('(prefers-color-scheme: dark)');
    return !!(m && typeof m.matches === 'boolean' && m.matches);
  } catch {
    return false;
  }
};

export function applyEarlyThemeFromStorageAndSystem() {
  try {
    let explicit = null;
    try { explicit = localStorage.getItem('et_viewer_theme'); } catch {}
    const mode = (explicit === 'dark' || explicit === 'light') ? explicit : (prefersDark() ? 'dark' : 'light');

    const prefsRaw = localStorage.getItem('pdfjs.preferences');
    let prefsObj = {};
    try { prefsObj = prefsRaw ? JSON.parse(prefsRaw) : {}; } catch {}
    prefsObj.viewerCssTheme = mode === 'dark' ? 2 : 1; // 1: light, 2: dark
    localStorage.setItem('pdfjs.preferences', JSON.stringify(prefsObj));

    document.documentElement.style.colorScheme = mode;
    document.documentElement.setAttribute('data-theme', mode);

    if (!(explicit === 'dark' || explicit === 'light')) {
      const onSchemeChange = () => {
        const m = prefersDark() ? 'dark' : 'light';
        document.documentElement.style.colorScheme = m;
        document.documentElement.setAttribute('data-theme', m);
        const raw = localStorage.getItem('pdfjs.preferences');
        let obj = {};
        try { obj = raw ? JSON.parse(raw) : {}; } catch {}
        obj.viewerCssTheme = m === 'dark' ? 2 : 1;
        localStorage.setItem('pdfjs.preferences', JSON.stringify(obj));
      };
      try {
        const mql = matchMedia('(prefers-color-scheme: dark)');
        if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onSchemeChange);
        else if (typeof mql.addListener === 'function') mql.addListener(onSchemeChange);
      } catch {}
    }
  } catch {}
}

export function applyEarlyPageTheme() {
  try {
    const saved = localStorage.getItem('et_page_theme');
    const sysDark = prefersDark();
    if (saved === 'dark' || (saved !== 'light' && sysDark)) {
      document.documentElement.setAttribute('data-page-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-page-theme');
    }
  } catch {}
}

export function setupThemeToggle() {
  const btn = document.getElementById('etThemeToggle');
  const menu = document.getElementById('etThemeMenu');
  const btnAuto = document.getElementById('etThemeAutoIcon');
  const btnLight = document.getElementById('etThemeLightIcon');
  const btnDark = document.getElementById('etThemeDarkIcon');
  const pageAuto = document.getElementById('etPageAutoIcon');
  const pageLight = document.getElementById('etPageLightIcon');
  const pageDark = document.getElementById('etPageDarkIcon');
  if (!btn || !menu || !btnAuto || !btnLight || !btnDark) return false;

  const setExplicit = (mode) => {
    try {
      if (mode === null) localStorage.removeItem('et_viewer_theme');
      else localStorage.setItem('et_viewer_theme', mode);
    } catch {}
  };

  const applyTheme = (mode) => {
    document.documentElement.style.colorScheme = mode;
    document.documentElement.setAttribute('data-theme', mode);
    try {
      const prefsRaw = localStorage.getItem('pdfjs.preferences');
      let prefsObj = {};
      try { prefsObj = prefsRaw ? JSON.parse(prefsRaw) : {}; } catch {}
      prefsObj.viewerCssTheme = mode === 'dark' ? 2 : 1;
      localStorage.setItem('pdfjs.preferences', JSON.stringify(prefsObj));
    } catch {}
    btn.setAttribute('aria-pressed', String(mode === 'dark'));
    btn.classList.toggle('toggled', mode === 'dark');
  };

  const computeSystem = () => (prefersDark() ? 'dark' : 'light');
  const markActive = (mode) => {
    for (const el of [btnAuto, btnLight, btnDark]) {
      el.classList.remove('toggled');
      el.setAttribute('aria-pressed', 'false');
    }
    if (mode === 'auto') {
      btnAuto.classList.add('toggled');
      btnAuto.setAttribute('aria-pressed', 'true');
      return;
    }
    if (mode === 'light') {
      btnLight.classList.add('toggled');
      btnLight.setAttribute('aria-pressed', 'true');
    }
    if (mode === 'dark') {
      btnDark.classList.add('toggled');
      btnDark.setAttribute('aria-pressed', 'true');
    }
  };

  const syncFromStorageOrSystem = () => {
    let explicit = null;
    try { explicit = localStorage.getItem('et_viewer_theme'); } catch {}
    if (explicit === 'dark' || explicit === 'light') {
      applyTheme(explicit);
      markActive(explicit);
    } else {
      const sys = computeSystem();
      applyTheme(sys);
      markActive('auto');
    }
  };

  const hideOtherMenus = () => {
    try {
      const others = document.querySelectorAll('.doorHanger, .doorHangerRight, .menu');
      for (const el of others) {
        if (el === menu) continue;
        el.classList.add('hidden');
        const id = el.id;
        if (id) {
          const controller = document.querySelector(`[aria-controls="${CSS.escape(id)}"]`);
          if (controller && controller.getAttribute('aria-expanded') === 'true') {
            controller.setAttribute('aria-expanded', 'false');
          }
        }
      }
    } catch {}
  };

  const openMenu = () => {
    hideOtherMenus();
    syncFromStorageOrSystem();
    try {
      const pagePref = localStorage.getItem('et_page_theme') || 'auto';
      setPageThemeVisual(pagePref);
    } catch {}
    menu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  };
  const closeMenu = () => {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };
  const toggleMenu = () => {
    if (menu.classList.contains('hidden')) openMenu(); else closeMenu();
  };

  // Init
  syncFromStorageOrSystem();

  btn.addEventListener('click', toggleMenu);
  btnAuto.addEventListener('click', () => { setExplicit(null); syncFromStorageOrSystem(); });
  btnLight.addEventListener('click', () => { setExplicit('light'); syncFromStorageOrSystem(); });
  btnDark.addEventListener('click', () => { setExplicit('dark'); syncFromStorageOrSystem(); });

  const setPageThemeVisual = (mode) => {
    for (const el of [pageAuto, pageLight, pageDark]) {
      if (!el) continue;
      el.classList.remove('toggled');
      el.setAttribute('aria-pressed', 'false');
    }
    if (mode === 'auto' && pageAuto) {
      pageAuto.classList.add('toggled');
      pageAuto.setAttribute('aria-pressed', 'true');
    }
    if (mode === 'light' && pageLight) {
      pageLight.classList.add('toggled');
      pageLight.setAttribute('aria-pressed', 'true');
    }
    if (mode === 'dark' && pageDark) {
      pageDark.classList.add('toggled');
      pageDark.setAttribute('aria-pressed', 'true');
    }
    try { localStorage.setItem('et_page_theme', mode); } catch {}
    if (mode === 'dark') {
      document.documentElement.setAttribute('data-page-theme', 'dark');
    } else if (mode === 'light') {
      document.documentElement.removeAttribute('data-page-theme');
    } else {
      const sys = computeSystem();
      if (sys === 'dark') document.documentElement.setAttribute('data-page-theme', 'dark');
      else document.documentElement.removeAttribute('data-page-theme');
    }
  };

  if (pageAuto) pageAuto.addEventListener('click', () => setPageThemeVisual('auto'));
  if (pageLight) pageLight.addEventListener('click', () => setPageThemeVisual('light'));
  if (pageDark) pageDark.addEventListener('click', () => setPageThemeVisual('dark'));
  try {
    const initPage = localStorage.getItem('et_page_theme') || 'auto';
    setPageThemeVisual(initPage);
  } catch {}

  const onSchemeChange = () => {
    let explicit = null;
    try { explicit = localStorage.getItem('et_viewer_theme'); } catch {}
    if (explicit !== 'dark' && explicit !== 'light') {
      syncFromStorageOrSystem();
    }
    try {
      const pagePref = localStorage.getItem('et_page_theme');
      if (pagePref !== 'dark' && pagePref !== 'light') setPageThemeVisual('auto');
    } catch {}
  };
  try {
    const mql = matchMedia('(prefers-color-scheme: dark)');
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onSchemeChange);
    else if (typeof mql.addListener === 'function') mql.addListener(onSchemeChange);
  } catch {}

  document.addEventListener('click', (e) => {
    const root = document.getElementById('etTheme');
    if (!root) return;
    if (!root.contains(e.target)) closeMenu();
  }, true);
  document.addEventListener('pointerdown', (e) => {
    const root = document.getElementById('etTheme');
    if (!root) return;
    if (!root.contains(e.target)) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  try {
    const closeIfOtherMenuOpens = (mutations) => {
      for (const m of mutations) {
        const t = m.target;
        if (!t || t === menu) continue;
        if (t.classList && (t.classList.contains('menu') || t.classList.contains('doorHanger') || t.classList.contains('doorHangerRight')) && !t.classList.contains('hidden')) {
          closeMenu();
          break;
        }
      }
    };
    const mo = new MutationObserver(closeIfOtherMenuOpens);
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  } catch {}

  return true;
}
