(function (global) {
  'use strict';

  var LANGUAGES = [
    {code: 'zh', label: '中文'},
    {code: 'ja', label: '日本語'},
    {code: 'en', label: 'English'},
    {code: 'ko', label: '한국어'}
  ];
  var NAVIGATION = [
    {id: 'intro', path: '/intro.html'},
    {id: 'rooms', path: '/rooms.html', aliases: ['/', '/dashboard.html']},
    {id: 'replays', path: '/replays.html'},
    {id: 'ladder', path: '/ladder.html'},
    {id: 'deckStats', path: '/deck-stats.html'},
    {id: 'playerStats', path: '/player-stats.html'},
    {id: 'usageStats', path: '/usage-stats.html', aliases: ['/deck-detail.html']},
    {id: 'settings', path: '/settings.html'}
  ];
  var NAV_TEXT = {
    zh: {intro: '使用介绍', rooms: '房间列表', replays: '录像下载', ladder: '天梯排行', deckStats: '卡组胜率', playerStats: '玩家战绩', usageStats: '使用率', settings: '设置', language: '语言', navigation: '主导航'},
    ja: {intro: '使用説明', rooms: 'ルーム一覧', replays: 'リプレイ', ladder: 'ランキング', deckStats: 'デッキ勝率', playerStats: 'プレイヤー戦績', usageStats: '使用率', settings: '設定', language: '言語', navigation: 'メインナビゲーション'},
    en: {intro: 'Usage Guide', rooms: 'Rooms', replays: 'Replays', ladder: 'Ladder', deckStats: 'Deck Rates', playerStats: 'Player Stats', usageStats: 'Usage', settings: 'Settings', language: 'Language', navigation: 'Primary navigation'},
    ko: {intro: '사용 가이드', rooms: '룸 목록', replays: '리플레이', ladder: '랭킹', deckStats: '덱 승률', playerStats: '플레이어 전적', usageStats: '사용률', settings: '설정', language: '언어', navigation: '주 탐색'}
  };
  var QUICK_ACTIONS = [
    {id: 'match', method: 'ladder'},
    {id: 'game', method: 'regular'},
    {id: 'deck', method: 'deckEditor'},
    {id: 'replay', method: 'replayList'}
  ];
  var QUICK_TEXT = {
    zh: {match: '一键匹配', game: '启动游戏', deck: '卡组编辑', replay: '查看录像', label: '游戏快捷操作'},
    ja: {match: 'ワンクリック対戦', game: 'ゲーム起動', deck: 'デッキ編集', replay: 'リプレイを見る', label: 'ゲームのクイック操作'},
    en: {match: 'Quick match', game: 'Launch game', deck: 'Edit deck', replay: 'View replays', label: 'Quick game actions'},
    ko: {match: '빠른 매칭', game: '게임 실행', deck: '덱 편집', replay: '리플레이 보기', label: '게임 빠른 실행'}
  };

  var query = new URLSearchParams(global.location.search);
  var language = detectLanguage(query);
  var options = null;
  var quickActionBusy = false;

  function detectLanguage(params) {
    var configured = params.get('L');
    if (configured === 'ja' || params.has('jp')) return 'ja';
    if (configured === 'en' || params.has('en')) return 'en';
    if (configured === 'ko' || params.has('kr')) return 'ko';
    return 'zh';
  }

  function text(dictionary, key) {
    var current = dictionary && dictionary[language];
    var fallback = dictionary && dictionary.zh;
    if (current && current[key] !== undefined) return current[key];
    if (fallback && fallback[key] !== undefined) return fallback[key];
    return key;
  }

  function localizedNavigation(key) {
    return (NAV_TEXT[language] && NAV_TEXT[language][key]) || NAV_TEXT.zh[key] || key;
  }

  function mixColor(start, end, amount) {
    var ratio = Math.max(0, Math.min(1, Number(amount) || 0));
    return 'rgb(' + [0, 1, 2].map(function (index) {
      return Math.round(start[index] + (end[index] - start[index]) * ratio);
    }).join(',') + ')';
  }

  // Shared semantic palette for every statistics page. A 50% rate is neutral;
  // the colour strengthens smoothly towards the same endpoints at 0% / 100%.
  function rateColor(rate) {
    var value = Number(rate);
    if (!Number.isFinite(value)) return '#dce6f0';
    value = Math.max(0, Math.min(100, value));
    if (Math.abs(value - 50) < 0.001) return '#dce6f0';
    var neutral = [220, 230, 240];
    return value > 50
      ? mixColor(neutral, [115, 214, 163], (value - 50) / 50)
      : mixColor(neutral, [239, 131, 127], (50 - value) / 50);
  }
  function rateClass(rate) {
    var value = Number(rate);
    if (!Number.isFinite(value)) return 'desktop-rate-50';
    return 'desktop-rate-' + Math.round(Math.max(0, Math.min(100, value)));
  }
  function semanticClass(value) {
    var number = Number(value);
    return number > 0 ? 'desktop-positive' : number < 0 ? 'desktop-negative' : 'desktop-rate-50';
  }

  function canonicalUrl(pathname) {
    var url = new URL(pathname, global.location.origin);
    if (language !== 'zh') url.searchParams.set('L', language);
    return url.pathname + url.search;
  }

  function isCurrentPage(item) {
    return global.location.pathname === item.path || (item.aliases || []).includes(global.location.pathname);
  }

  function renderShell() {
    var root = document.querySelector('[data-site-shell]');
    if (!root) return;
    root.innerHTML = '';

    var titleRow = document.createElement('div');
    titleRow.className = 'desktop-title-row';
    var title = document.createElement('h1');
    title.textContent = text(options.translations, options.titleKey || 'title');
    titleRow.appendChild(title);
    var quickActions = document.createElement('div');
    quickActions.className = 'desktop-quick-actions';
    quickActions.setAttribute('aria-label', QUICK_TEXT[language].label);
    QUICK_ACTIONS.forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'desktop-quick-action' + (item.id === 'match' ? ' primary' : '');
      button.textContent = QUICK_TEXT[language][item.id];
      button.disabled = quickActionBusy;
      button.addEventListener('click', async function () {
        if (quickActionBusy || !global.SrvproDesktop) return;
        quickActionBusy = true;
        document.querySelectorAll('.desktop-quick-action').forEach(function (control) { control.disabled = true; });
        try {
          await global.SrvproDesktop[item.method]();
        } finally {
          quickActionBusy = false;
          document.querySelectorAll('.desktop-quick-action').forEach(function (control) { control.disabled = false; });
        }
      });
      quickActions.appendChild(button);
    });
    titleRow.appendChild(quickActions);
    root.appendChild(titleRow);

    var languageRoot = document.createElement('div');
    languageRoot.className = 'langbtns';
    var languageButton = document.createElement('button');
    languageButton.type = 'button';
    languageButton.className = 'lbtn-main';
    languageButton.setAttribute('aria-haspopup', 'true');
    languageButton.setAttribute('aria-expanded', 'false');
    languageButton.setAttribute('aria-label', localizedNavigation('language'));
    languageButton.textContent = '🌐 ' + LANGUAGES.find(function (item) { return item.code === language; }).label;
    var menu = document.createElement('div');
    menu.className = 'lang-menu';
    LANGUAGES.forEach(function (item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'lbtn' + (item.code === language ? ' active' : '');
      button.textContent = item.label;
      button.setAttribute('aria-pressed', item.code === language ? 'true' : 'false');
      button.addEventListener('click', function () { setLanguage(item.code); });
      menu.appendChild(button);
    });
    languageButton.addEventListener('click', function (event) {
      event.stopPropagation();
      var open = menu.classList.toggle('open');
      languageButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    languageRoot.appendChild(languageButton);
    languageRoot.appendChild(menu);
    root.appendChild(languageRoot);

    var navigation = document.createElement('nav');
    navigation.className = 'nav';
    navigation.setAttribute('aria-label', localizedNavigation('navigation'));
    NAVIGATION.forEach(function (item) {
      var link = document.createElement('a');
      link.href = canonicalUrl(item.path);
      link.textContent = localizedNavigation(item.id);
      if (isCurrentPage(item)) {
        link.className = 'active';
        link.setAttribute('aria-current', 'page');
      }
      navigation.appendChild(link);
    });
    root.appendChild(navigation);
  }

  function translatePage() {
    var htmlKeys = new Set(options.htmlKeys || []);
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : language;
    document.title = text(options.translations, options.titleKey || 'title');
    document.querySelectorAll('[data-i18n]').forEach(function (element) {
      var key = element.getAttribute('data-i18n');
      if (htmlKeys.has(key)) element.innerHTML = text(options.translations, key);
      else element.textContent = text(options.translations, key);
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (element) {
      element.placeholder = text(options.translations, element.getAttribute('data-i18n-ph'));
    });
  }

  function applyLanguage(notify) {
    renderShell();
    translatePage();
    if (notify && typeof options.onLanguageChange === 'function') options.onLanguageChange(language);
  }

  function setLanguage(code) {
    if (!LANGUAGES.some(function (item) { return item.code === code; })) return;
    language = code;
    var url = new URL(global.location.href);
    url.searchParams.delete('L');
    url.searchParams.delete('jp');
    url.searchParams.delete('en');
    url.searchParams.delete('kr');
    if (code !== 'zh') url.searchParams.set('L', code);
    global.history.replaceState(null, '', url.toString());
    if (global.SrvproDesktop) global.SrvproDesktop.setLanguage(code);
    applyLanguage(true);
  }

  document.addEventListener('click', function (event) {
    var languageRoot = document.querySelector('.langbtns');
    if (!languageRoot || languageRoot.contains(event.target)) return;
    var menu = languageRoot.querySelector('.lang-menu');
    var button = languageRoot.querySelector('.lbtn-main');
    if (menu) menu.classList.remove('open');
    if (button) button.setAttribute('aria-expanded', 'false');
  });

  global.SrvproWeb = Object.freeze({
    getLanguage: function () { return language; },
    init: function (configuration) {
      options = configuration || {};
      applyLanguage(false);
    },
    rateColor: rateColor,
    rateClass: rateClass,
    semanticClass: semanticClass,
    semanticColor: function (value) {
      var number = Number(value);
      return number > 0 ? '#73d6a3' : number < 0 ? '#ef837f' : '#dce6f0';
    },
    t: text
  });
})(window);
