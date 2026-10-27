(function (global) {
  'use strict';
  // These hrefs are public fallbacks; the native bridge captures every game action.
  global.SRVPRO_WEB_CLIENT_URL='https://ocg1103nexus.com/';
  global.SRVPRO_WEB_CLIENT_ENABLED=true;

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
    {id: 'usageStats', path: '/usage-stats.html', aliases: ['/deck-detail.html']}
  ];
  var NAV_TEXT = {
    zh: {intro: '使用介绍', rooms: '房间列表', replays: '录像下载', ladder: '天梯排行', deckStats: '卡组胜率', playerStats: '玩家战绩', usageStats: '使用率', language: '语言', navigation: '主导航'},
    ja: {intro: '使用説明', rooms: 'ルーム一覧', replays: 'リプレイ', ladder: 'ランキング', deckStats: 'デッキ勝率', playerStats: 'プレイヤー戦績', usageStats: '使用率', language: '言語', navigation: 'メインナビゲーション'},
    en: {intro: 'Usage Guide', rooms: 'Rooms', replays: 'Replays', ladder: 'Ladder', deckStats: 'Deck Rates', playerStats: 'Player Stats', usageStats: 'Usage', language: 'Language', navigation: 'Primary navigation'},
    ko: {intro: '사용 가이드', rooms: '룸 목록', replays: '리플레이', ladder: '랭킹', deckStats: '덱 승률', playerStats: '플레이어 전적', usageStats: '사용률', language: '언어', navigation: '주 탐색'}
  };
  var ENTRY_TEXT = {
    zh: {ladder:'一键匹配', home:'开始游戏', 'deck-editor':'卡组编辑', 'replay-list':'查看录像', regular:'网页联机', match:'点击匹配', settings:'设置', username:'账号', password:'密码', remember:'记住密码', save:'保存', clear:'清除已保存账号', close:'关闭', self:'查询自己', ranking:'查询我的天梯排行', stats:'查询我的玩家战绩', note:'账号默认保存；未勾选记住密码时，密码仅在当前标签页保留。', saved:'已保存', memory:'浏览器存储不可用，账号仅在当前页面保留。', cleared:'已清除已保存账号', required:'请先在设置中保存账号。', invalid:'账号或密码格式不适用于游戏入口，请检查设置（合计最多 19 个字符，不含 $ 或换行）。', blocked:'新窗口未能打开，请允许弹窗后重试。', waiting:'正在向网页版交接账号…', accepted:'网页版已接收账号，实际登录结果请查看游戏页面。', failed:'网页版未能接收账号，请在游戏页面手动填写或重试。', cancelled:'已取消账号交接。', timeout:'账号交接超时，请在游戏页面手动填写或重试。'},
    ja: {ladder:'クイックマッチ', home:'ゲーム開始', 'deck-editor':'デッキ編集', 'replay-list':'リプレイ一覧', regular:'Web対戦', match:'マッチする', settings:'設定', username:'アカウント', password:'パスワード', remember:'パスワードを保存', save:'保存', clear:'保存したアカウントを削除', close:'閉じる', self:'自分を検索', ranking:'自分のランキング', stats:'自分の戦績', note:'アカウントは保存されます。パスワードの保存を選ばない場合、このタブ内のみ保持します。', saved:'保存しました', memory:'ブラウザーの保存機能が使えないため、このページ内のみ保持します。', cleared:'保存したアカウントを削除しました', required:'設定でアカウントを保存してください。', invalid:'ゲーム用のアカウントとパスワードを確認してください（合計19文字以内、$や改行は不可）。', blocked:'新しいウィンドウを開けませんでした。ポップアップを許可して再試行してください。', waiting:'Web版へアカウントを送信中…', accepted:'Web版がアカウントを受信しました。ログイン結果はゲーム画面で確認してください。', failed:'アカウントを受信できませんでした。ゲーム画面で入力するか再試行してください。', cancelled:'アカウントの送信を中止しました。', timeout:'送信がタイムアウトしました。ゲーム画面で入力するか再試行してください。'},
    en: {ladder:'Quick match', home:'Start game', 'deck-editor':'Deck editor', 'replay-list':'View replays', regular:'Play online', match:'Join matchmaking', settings:'Settings', username:'Account', password:'Password', remember:'Remember password', save:'Save', clear:'Clear saved account', close:'Close', self:'Find myself', ranking:'My ladder ranking', stats:'My player stats', note:'Your account is saved by default. Without Remember password, the password stays in this tab only.', saved:'Saved', memory:'Browser storage is unavailable. The account stays in this page only.', cleared:'Saved account cleared', required:'Save your account in Settings first.', invalid:'Check the game account and password (19 characters combined at most; no $, backslash or line breaks).', blocked:'The new window could not open. Allow popups and try again.', waiting:'Sending account to the web client…', accepted:'The web client received the account. Check the game page for the login result.', failed:'The web client could not receive the account. Enter it on the game page or retry.', cancelled:'Account transfer cancelled.', timeout:'Account transfer timed out. Enter it on the game page or retry.'},
    ko: {ladder:'빠른 매칭', home:'게임 시작', 'deck-editor':'덱 편집', 'replay-list':'리플레이 보기', regular:'웹 대전', match:'매칭 참가', settings:'설정', username:'계정', password:'비밀번호', remember:'비밀번호 기억', save:'저장', clear:'저장된 계정 삭제', close:'닫기', self:'내 정보 조회', ranking:'내 랭킹 조회', stats:'내 전적 조회', note:'계정은 기본으로 저장됩니다. 비밀번호 기억을 선택하지 않으면 현재 탭에서만 유지됩니다.', saved:'저장됨', memory:'브라우저 저장소를 사용할 수 없어 현재 페이지에서만 유지됩니다.', cleared:'저장된 계정을 삭제했습니다', required:'설정에서 계정을 먼저 저장하세요.', invalid:'게임 계정과 비밀번호를 확인하세요(합계 19자 이하, $ 및 줄바꿈 제외).', blocked:'새 창을 열 수 없습니다. 팝업을 허용한 후 다시 시도하세요.', waiting:'웹 클라이언트로 계정 전달 중…', accepted:'웹 클라이언트가 계정을 받았습니다. 로그인 결과는 게임 화면에서 확인하세요.', failed:'계정을 전달하지 못했습니다. 게임 화면에서 입력하거나 다시 시도하세요.', cancelled:'계정 전달이 취소되었습니다.', timeout:'계정 전달 시간이 초과되었습니다. 게임 화면에서 입력하거나 다시 시도하세요.'}
  };

  var query = new URLSearchParams(global.location.search);
  var language = detectLanguage(query);
  var options = null;
  var accountKey = 'srvpro.website.account.v1';
  var sessionKey = 'srvpro.website.password.v1';
  var memoryAccount = null;
  var settingsDialog = null;

  function entryText(key) { return text(ENTRY_TEXT, key); }
  function readStorage(name, key) {
    try { return JSON.parse(global[name].getItem(key) || 'null'); } catch (error) { return null; }
  }
  function writeStorage(name, key, value) {
    try {
      if (value === null) global[name].removeItem(key);
      else global[name].setItem(key, JSON.stringify(value));
      return true;
    } catch (error) { return false; }
  }
  function getAccount() {
    if (memoryAccount) return Object.assign({}, memoryAccount);
    var saved = readStorage('localStorage', accountKey) || {};
    var temporary = readStorage('sessionStorage', sessionKey) || {};
    var username = typeof saved.username === 'string' ? saved.username : '';
    var remember = saved.rememberPassword === true;
    return {username: username, password: remember && typeof saved.password === 'string' ? saved.password :
      temporary.username === username && typeof temporary.password === 'string' ? temporary.password : '', rememberPassword: remember};
  }
  function saveAccount(value) {
    var account = {username: String(value.username || '').trim(), password: String(value.password || ''), rememberPassword: value.rememberPassword === true};
    if (/[\0\r\n\\$]/.test(account.username) || account.username.length > 19) throw new Error('Invalid account');
    memoryAccount = account;
    var persistent = {username: account.username, rememberPassword: account.rememberPassword};
    if (account.rememberPassword) persistent.password = account.password;
    var localOk = writeStorage('localStorage', accountKey, persistent);
    var sessionOk = writeStorage('sessionStorage', sessionKey, account.rememberPassword ? null : {username: account.username, password: account.password});
    return localOk && sessionOk;
  }
  function clearAccount() {
    memoryAccount = {username:'', password:'', rememberPassword:false};
    writeStorage('localStorage', accountKey, null);
    writeStorage('sessionStorage', sessionKey, null);
  }
  function showEntryStatus(key) {
    var status = settingsDialog && settingsDialog.querySelector('[role="status"]') || document.querySelector('[data-entry-status]');
    if (status) { status.textContent = entryText(key); status.hidden = false; }
  }
  function consumeSelfQuery() {
    var url = new URL(global.location.href);
    if (url.searchParams.get('self') !== '1') return null;
    url.searchParams.delete('self');
    global.history.replaceState(null, '', url.toString());
    return getAccount();
  }
  function querySelf(kind) {
    var account = getAccount();
    if (!account.username) { openSettings(); showEntryStatus('required'); return; }
    if (/[\0\r\n\\$]/.test(account.username) || account.username.length > 19) { showEntryStatus('invalid'); return; }
    if (options && typeof options.onQuerySelf === 'function' && options.selfQueryKind === kind) {
      options.onQuerySelf(account);
      if (settingsDialog) settingsDialog.close();
      return;
    }
    var url = new URL(canonicalUrl(kind === 'ranking' ? '/ladder.html' : '/player-stats.html'), global.location.origin);
    url.searchParams.set('self', '1');
    global.location.assign(url.href);
  }

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

  function canonicalUrl(pathname) {
    var url = new URL(pathname, global.location.origin);
    if (language !== 'zh') url.searchParams.set('L', language);
    return url.pathname + url.search;
  }

  function isCurrentPage(item) {
    return global.location.pathname === item.path || (item.aliases || []).includes(global.location.pathname);
  }

  function clientEnabled() { return global.SRVPRO_WEB_CLIENT_ENABLED !== false; }

  function clientEntry() {
    if (!clientEnabled()) throw new Error('Web client entry is disabled in web-client-config.js');
    var url = new URL(global.SRVPRO_WEB_CLIENT_URL);
    var privateKeys = ['username','password','account','player','nickname','passwd','token'];
    var hashParams = new URLSearchParams(url.hash.split('?')[1] || '');
    if (url.protocol !== 'https:' || url.username || url.password || privateKeys.some(function (key) { return url.searchParams.has(key) || hashParams.has(key); })) {
      throw new Error('Configure an HTTPS webpage without credentials in web-client-config.js');
    }
    // Explicit zh also overrides a different language saved in the client.
    url.searchParams.set('lang', language);
    // A configured route must not carry a stale hash language with precedence.
    var separator = url.hash.indexOf('?');
    if (separator >= 0) {
      var params = new URLSearchParams(url.hash.slice(separator + 1));
      if (params.has('lang')) {
        params.delete('lang');
        var path = url.hash.slice(0, separator);
        url.hash = params.toString() ? path + '?' + params.toString() : path;
      }
    }
    return url;
  }

  function entryUrl(intent, configuration) {
    var url = clientEntry(), config = configuration || {};
    if (intent === 'home') return url;
    if (!['regular', 'ladder', 'deck-editor', 'replay-list', 'spectate'].includes(intent)) throw new Error('Invalid entry');
    ['v','intent','room','spectate','autojoin','bridge','origin','request'].forEach(function (key) { url.searchParams.delete(key); });
    url.hash = '';
    url.searchParams.set('intent', intent);
    if (config.room) {
      if (typeof config.room !== 'string' || config.room.length > 19 || /[\0\r\n$]/.test(config.room)) throw new Error('Invalid room');
      url.searchParams.set('room', config.room);
    }
    if (config.autojoin === false) url.searchParams.set('autojoin', '0');
    return url;
  }

  function openClient(intent, configuration) {
    var url;
    try { url = entryUrl(intent, configuration); } catch (error) { showEntryStatus('failed'); return false; }
    var account = getAccount();
    if (intent === 'home' || !account.username || !account.password) {
      // Public links preserve the client's existing identity and do not need an opener.
      global.open(url.href, '_blank', 'noopener,noreferrer');
      return true;
    }
    var nickname = account.username + '$' + account.password;
    if (nickname.length > 19 || /[\0\r\n\\]/.test(nickname) || account.username.includes('$') || account.password.includes('$')) {
      showEntryStatus('invalid'); return false;
    }
    var request;
    try {
      request = Array.from(global.crypto.getRandomValues(new Uint8Array(16))).map(function (n) { return n.toString(16).padStart(2, '0'); }).join('');
    } catch (error) { showEntryStatus('failed'); return false; }
    var params = new URLSearchParams({v:'1', intent:intent, bridge:'1', origin:global.location.origin, request:request});
    if (configuration && configuration.room) params.set('room', configuration.room);
    if (configuration && configuration.autojoin === false) params.set('autojoin', '0');
    ['intent','room','autojoin'].forEach(function (key) { url.searchParams.delete(key); });
    url.hash = '/entry?' + params.toString();
    var child, sent = false, finished = false, timer, poll;
    function cleanup() {
      finished = true;
      global.clearTimeout(timer); global.clearInterval(poll);
      global.removeEventListener('message', receive);
      global.removeEventListener('pagehide', cleanup);
      account = null; child = null;
    }
    function receive(event) {
      var data = event.data;
      if (finished || event.origin !== url.origin || event.source !== child || !data ||
          data.channel !== 'srvprotiantiweb:entry' || data.version !== 1 || data.request !== request || data.intent !== intent) return;
      if (data.type === 'ready' && !sent) {
        sent = true;
        try { child.postMessage({channel:data.channel, version:1, type:'payload', request:request, intent:intent,
          credentials:{username:account.username, password:account.password}}, url.origin); }
        catch (error) { cleanup(); showEntryStatus('failed'); }
      } else if (data.type === 'result' && ['accepted','failed','cancelled'].includes(data.status)) {
        cleanup(); showEntryStatus(data.status);
      }
    }
    global.addEventListener('message', receive);
    global.addEventListener('pagehide', cleanup);
    // The receiver needs the real opener only for this authenticated transfer.
    try { child = global.open(url.href, '_blank'); } catch (error) { child = null; }
    if (!child) { cleanup(); showEntryStatus('blocked'); return false; }
    showEntryStatus('waiting');
    timer = global.setTimeout(function () { cleanup(); showEntryStatus('timeout'); }, 45000);
    poll = global.setInterval(function () { if (child && child.closed) { cleanup(); showEntryStatus('cancelled'); } }, 500);
    return true;
  }

  function bindClientLink(link, intent, configuration, label) {
    link.setAttribute('data-client-intent', intent);
    if (configuration && configuration.room) link.setAttribute('data-client-room', configuration.room);
    try { link.href = entryUrl(intent, configuration).href; } catch (error) { link.hidden = true; return; }
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = entryText(label || intent);
    link.addEventListener('click', function (event) {
      // Modified clicks deliberately use the public, credential-free href.
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
      event.preventDefault(); openClient(intent, configuration);
    });
  }
  function createClientLink(intent, configuration, label) {
    var link = document.createElement('a');
    bindClientLink(link, intent, configuration, label);
    return link;
  }
  function createWebClientEntry() {
    try { clientEntry(); } catch (error) { return null; }
    var group = document.createElement('div');
    group.className = 'site-client-actions';
    ['ladder','home','deck-editor','replay-list'].forEach(function (intent) {
      var link = createClientLink(intent);
      link.className = 'site-play-link' + (intent === 'ladder' ? ' primary' : ' secondary');
      link.setAttribute('data-client-intent', intent);
      group.appendChild(link);
    });
    return group;
  }

  function openSettings() {
    if (settingsDialog) settingsDialog.remove();
    var previousFocus = document.activeElement;
    var dialog = document.createElement('dialog');
    settingsDialog = dialog;
    dialog.className = 'site-settings-dialog';
    dialog.setAttribute('aria-labelledby', 'site-settings-title');
    var heading = document.createElement('h2'); heading.id = 'site-settings-title'; heading.textContent = entryText('settings'); dialog.appendChild(heading);
    var form = document.createElement('form');
    var account = getAccount();
    function field(key, type, value) {
      var label = document.createElement('label'); label.textContent = entryText(key);
      var input = document.createElement('input'); input.name = key; input.type = type; input.value = value;
      input.autocomplete = type === 'password' ? 'current-password' : 'username';
      label.appendChild(input); form.appendChild(label); return input;
    }
    var username = field('username', 'text', account.username);
    var password = field('password', 'password', account.password);
    var rememberLabel = document.createElement('label'); rememberLabel.className = 'site-remember';
    var remember = document.createElement('input'); remember.type = 'checkbox'; remember.name = 'rememberPassword'; remember.checked = account.rememberPassword;
    rememberLabel.appendChild(remember); rememberLabel.appendChild(document.createTextNode(entryText('remember'))); form.appendChild(rememberLabel);
    var note = document.createElement('p'); note.className = 'muted'; note.textContent = entryText('note'); form.appendChild(note);
    var status = document.createElement('p'); status.className = 'site-settings-status'; status.setAttribute('role', 'status'); form.appendChild(status);
    var actions = document.createElement('div'); actions.className = 'web-controls';
    function action(key, callback, type) {
      var button = document.createElement('button'); button.type = type || 'button'; button.textContent = entryText(key);
      if (callback) button.addEventListener('click', callback); actions.appendChild(button); return button;
    }
    action('save', null, 'submit');
    action('clear', function () { clearAccount(); username.value = ''; password.value = ''; remember.checked = false; status.textContent = entryText('cleared'); });
    action('ranking', function () { querySelf('ranking'); });
    action('stats', function () { querySelf('stats'); });
    action('close', function () { dialog.close(); });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      try {
        var stored = saveAccount({username:username.value, password:password.value, rememberPassword:remember.checked});
        status.textContent = entryText(stored ? 'saved' : 'memory');
      } catch (error) { status.textContent = entryText('invalid'); }
    });
    dialog.addEventListener('close', function () { dialog.remove(); if (settingsDialog === dialog) settingsDialog = null; if (previousFocus && previousFocus.isConnected) previousFocus.focus(); });
    form.appendChild(actions); dialog.appendChild(form); document.body.appendChild(dialog); dialog.showModal();
  }

  function renderShell() {
    var root = document.querySelector('[data-site-shell]');
    if (!root) return;
    document.documentElement.classList.toggle('web-client-disabled', !clientEnabled());
    root.innerHTML = '';

    var titleRow = document.createElement('div');
    titleRow.className = 'site-title-row';
    var title = document.createElement('h1');
    title.textContent = text(options.translations, options.titleKey || 'title');
    titleRow.appendChild(title);
    var clientLink = createWebClientEntry();
    if (clientLink) titleRow.appendChild(clientLink);
    root.appendChild(titleRow);
    var entryStatus = document.createElement('p'); entryStatus.className = 'site-entry-status'; entryStatus.hidden = true;
    entryStatus.setAttribute('data-entry-status', ''); entryStatus.setAttribute('role', 'status'); root.appendChild(entryStatus);

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
    document.querySelectorAll('[data-web-intent]').forEach(function (link) {
      var intent = link.getAttribute('data-web-intent');
      link.textContent = entryText(intent);
      try { link.href = entryUrl(intent).href; } catch (error) { link.hidden = true; }
      if (!link.dataset.entryBound) { bindClientLink(link, intent); link.dataset.entryBound = '1'; }
    });
    document.querySelectorAll('[data-query-self]').forEach(function (button) {
      button.textContent = entryText('self');
      if (!button.dataset.entryBound) {
        button.addEventListener('click', function () { querySelf(button.getAttribute('data-query-self')); });
        button.dataset.entryBound = '1';
      }
    });
    if (notify && typeof options.onLanguageChange === 'function') options.onLanguageChange(language);
    if (typeof global.CustomEvent === 'function') document.dispatchEvent(new global.CustomEvent('srvpro-language-change'));
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

  function rateClass(rate) {
    var value=Number(rate);
    return 'desktop-rate-'+(Number.isFinite(value)?Math.round(Math.max(0,Math.min(100,value))):50);
  }
  function semanticClass(value) { return Number(value)>0?'desktop-positive':Number(value)<0?'desktop-negative':'desktop-rate-50'; }
  global.SrvproWeb = Object.freeze({
    clientEnabled: clientEnabled,
    clientEntry: clientEntry,
    entryUrl: entryUrl,
    openClient: openClient,
    createClientLink: createClientLink,
    getAccount: getAccount,
    saveAccount: saveAccount,
    clearAccount: clearAccount,
    querySelf: querySelf,
    consumeSelfQuery: consumeSelfQuery,
    getLanguage: function () { return language; },
    init: function (configuration) {
      options = configuration || {};
      applyLanguage(false);
    },
    deckRateColor: function(rate) { return rateColor(50 + (Number(rate) - 50) * 2); },
    rateColor: rateColor,
    rateClass: rateClass,
    deckRateClass: function(rate) { return rateClass(50+(Number(rate)-50)*2); },
    semanticClass: semanticClass,
    semanticColor: function (value) {
      var number = Number(value);
      return number > 0 ? '#73d6a3' : number < 0 ? '#ef837f' : '#dce6f0';
    },
    t: text
  });
})(window);
