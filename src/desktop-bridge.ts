import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

type Language = 'zh' | 'ja' | 'en' | 'ko';
type Settings = {
  player: { launchName: string };
  server: { gameHost: string; gamePort: number; apiBaseUrl: string };
  game: { executable: string };
  ui: { language: Language };
};
type ScriptResult = { status: string; files: string[] };
type ScriptProgress = { done: number; total: number; message: string };
type ApiResponse = { status: number; contentType: string; bodyBase64: string };
type SaveOutcome = { filename: string; savedPath: string; launchError: string | null };
type DesktopBridge = {
  settings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<Settings>;
  resetSettings(): Promise<Settings>;
  setLanguage(language: Language): void;
  regular(): Promise<void>;
  ladder(): Promise<void>;
  watchRoom(room: Record<string, unknown>): Promise<void>;
  scriptState(): Promise<{ commit: string | null; canRestore: boolean; updatedAt: number | null }>;
  updateScripts(overwriteConflicts: boolean): Promise<ScriptResult>;
  restoreScripts(): Promise<ScriptResult>;
  onScriptProgress(callback: (progress: ScriptProgress) => void): void;
};

declare global {
  interface Window {
    SrvproDesktop: DesktopBridge;
    desktopRegular(): void;
    desktopLadder(): void;
    desktopUpdateScripts(): void;
    __TAURI_INTERNALS__?: unknown;
  }
}

const languages: Language[] = ['zh', 'ja', 'en', 'ko'];
const messages: Record<Language, Record<string, string>> = {
  zh: {
    copied: '已复制：',
    savedDeck: '卡组已保存并在游戏中打开', savedReplay: '录像已保存并在游戏中播放',
    savedNotOpened: '文件已保存，但游戏未能启动', retryOpen: '重试打开',
    failed: '操作失败', setName: '请先在设置中填写游戏昵称', openDeck: '保存并编辑',
    openReplay: '保存并播放', update: '更新旧裁定脚本', checking: '正在处理……',
    roomGone: '房间已关闭或状态已变化，请刷新后重试', roomLocked: '该房间暂不能直接观战'
  },
  ja: {
    copied: 'コピーしました：',
    savedDeck: 'デッキを保存してゲームで開きました', savedReplay: 'リプレイを保存してゲームで再生しました',
    savedNotOpened: 'ファイルは保存されましたが、ゲームを起動できませんでした', retryOpen: 'もう一度開く',
    failed: '失敗', setName: '設定でゲーム名を入力してください', openDeck: '保存して編集',
    openReplay: '保存して再生', update: '旧裁定を更新', checking: '処理中…',
    roomGone: 'ルームが終了または変更されました。更新してください', roomLocked: 'このルームは直接観戦できません'
  },
  en: {
    copied: 'Copied: ',
    savedDeck: 'Deck saved and opened in the game', savedReplay: 'Replay saved and opened in the game',
    savedNotOpened: 'File saved, but the game could not start', retryOpen: 'Retry opening',
    failed: 'Operation failed', setName: 'Set your game name in Settings first', openDeck: 'Save and edit',
    openReplay: 'Save and play', update: 'Update old ruling scripts', checking: 'Working…',
    roomGone: 'The room closed or changed. Refresh and try again', roomLocked: 'This room cannot be watched directly'
  },
  ko: {
    copied: '복사됨: ',
    savedDeck: '덱을 저장하고 게임에서 열었습니다', savedReplay: '리플레이를 저장하고 게임에서 재생했습니다',
    savedNotOpened: '파일은 저장했지만 게임을 실행하지 못했습니다', retryOpen: '다시 열기',
    failed: '작업 실패', setName: '설정에서 게임 이름을 입력하세요', openDeck: '저장 후 편집',
    openReplay: '저장 후 재생', update: '옛 재정 스크립트 업데이트', checking: '처리 중…',
    roomGone: '방이 종료되었거나 상태가 변경되었습니다. 새로고침하세요', roomLocked: '이 방은 직접 관전할 수 없습니다'
  }
};

function currentLanguage(): Language {
  const value = new URLSearchParams(location.search).get('L');
  if (languages.includes(value as Language)) return value as Language;
  const stored = localStorage.getItem('srvprotianti.language');
  return languages.includes(stored as Language) ? stored as Language : 'zh';
}
function msg(key: string): string {
  return messages[currentLanguage()][key] || messages.zh[key] || key;
}
function toast(message: string, error = false, action?: { label: string; onClick: () => void }) {
  const mount = () => {
    let element = document.getElementById('desktop-toast');
    if (!element) {
      element = document.createElement('div');
      element.id = 'desktop-toast';
      element.setAttribute('role', 'status');
      element.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:10000;max-width:440px;padding:12px 16px;border-radius:6px;background:#244b68;color:#fff;box-shadow:0 4px 18px #0008;white-space:pre-wrap';
      document.body.appendChild(element);
    }
    element.textContent = message;
    element.style.background = error ? '#813e3e' : '#244b68';
    const toastId = String(Date.now()) + Math.random();
    element.dataset.toastId = toastId;
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.style.cssText = 'display:block;margin-top:8px;padding:6px 10px;cursor:pointer';
      button.onclick = action.onClick;
      element.appendChild(button);
    }
    window.setTimeout(() => { if (element?.dataset.toastId === toastId) element.textContent = ''; }, action ? 30000 : 7000);
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

const tauriAvailable = Boolean(window.__TAURI_INTERNALS__);
const browserFetch = window.fetch.bind(window);
const defaultSettings: Settings = {
  player: { launchName: '' },
  server: { gameHost: '121.4.34.71', gamePort: 7911, apiBaseUrl: 'http://121.4.34.71:7922' },
  game: { executable: 'ygopro.exe' },
  ui: { language: 'zh' }
};
let cachedSettings: Settings | null = null;
const settingsPromise = tauriAvailable
  ? invoke<Settings>('get_settings').then(value => {
      cachedSettings = value;
      if (!new URLSearchParams(location.search).has('L') &&
          !['jp', 'en', 'kr'].some(key => new URLSearchParams(location.search).has(key)) &&
          value.ui.language !== currentLanguage()) {
        localStorage.setItem('srvprotianti.language', value.ui.language);
        const url = new URL(location.href);
        if (value.ui.language !== 'zh') url.searchParams.set('L', value.ui.language);
        location.replace(url.pathname + url.search + url.hash);
      }
      updateIntroButtons();
      return value;
    })
  : Promise.resolve(defaultSettings);

try {
  const params = new URLSearchParams(location.search);
  if (!params.has('L') && !['jp', 'en', 'kr'].some(key => params.has(key))) {
    const saved = localStorage.getItem('srvprotianti.language');
    if (saved && saved !== 'zh' && languages.includes(saved as Language)) {
      params.set('L', saved);
      history.replaceState(null, '', location.pathname + '?' + params + location.hash);
    }
  }
} catch { /* local storage may be unavailable; the page defaults to Chinese */ }

function bytesFromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const isApi = url.origin === location.origin &&
    (url.pathname.startsWith('/api/') || url.pathname.startsWith('/example_decks/'));
  if (!isApi || !tauriAvailable) return browserFetch(input, init);
  await settingsPromise;
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const body = typeof init?.body === 'string' ? init.body : '';
  const result = await invoke<ApiResponse>('api_request', {
    route: url.pathname + url.search,
    method,
    body
  });
  const responseBody = [204, 205, 304].includes(result.status)
    ? null
    : bytesFromBase64(result.bodyBase64);
  return new Response(responseBody, {
    status: result.status,
    headers: { 'content-type': result.contentType }
  });
}
window.fetch = apiFetch;

const objectUrls = new Map<string, Blob>();
const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (object: Blob | MediaSource) => {
  const url = nativeCreateObjectURL(object);
  if (object instanceof Blob) objectUrls.set(url, object);
  return url;
};
URL.revokeObjectURL = (url: string) => {
  nativeRevokeObjectURL(url);
  queueMicrotask(() => objectUrls.delete(url));
};

const busyAnchors = new WeakSet<HTMLAnchorElement>();
function downloadName(anchor: HTMLAnchorElement): string {
  if (anchor.download) return anchor.download;
  const url = new URL(anchor.href, location.href);
  if (url.pathname === '/api/ladder/deck-template') return url.searchParams.get('filename') || '';
  return decodeURIComponent(url.pathname.split('/').pop() || '');
}
function downloadKind(anchor: HTMLAnchorElement): 'deck' | 'replay' | null {
  if (!anchor.hasAttribute('download')) return null;
  const filename = downloadName(anchor);
  if (/\.ydk$/i.test(filename)) return 'deck';
  if (/\.yrp$/i.test(filename)) return 'replay';
  return null;
}
async function handleDownload(anchor: HTMLAnchorElement): Promise<void> {
  const kind = downloadKind(anchor);
  if (!kind || busyAnchors.has(anchor)) return;
  busyAnchors.add(anchor);
  const priorText = anchor.textContent || '';
  anchor.setAttribute('aria-busy', 'true');
  try {
    if (!tauriAvailable) throw new Error('Open this page in the desktop program');
    let bytesBase64: string | null = null;
    let route: string | null = null;
    if (anchor.href.startsWith('blob:')) {
      const blob = objectUrls.get(anchor.href);
      if (!blob) throw new Error('Download data is unavailable');
      bytesBase64 = base64FromBytes(new Uint8Array(await blob.arrayBuffer()));
    } else {
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin) throw new Error('Download origin is invalid');
      route = url.pathname + url.search;
    }
    anchor.textContent = msg('checking');
    const outcome = await invoke<SaveOutcome>('save_and_open', {
      kind,
      filename: downloadName(anchor),
      route,
      bytesBase64
    });
    if (outcome.launchError) {
      toast(msg('savedNotOpened') + ': ' + outcome.savedPath + '\n' + outcome.launchError, true, {
        label: msg('retryOpen'),
        onClick: () => {
          void invoke('open_saved', { kind, filename: outcome.filename })
            .then(() => toast(msg(kind === 'deck' ? 'savedDeck' : 'savedReplay')))
            .catch(error => toast(msg('savedNotOpened') + ': ' + outcome.savedPath + '\n' + String(error), true));
        }
      });
    } else {
      toast(msg(kind === 'deck' ? 'savedDeck' : 'savedReplay'));
    }
  } catch (error) {
    toast(msg('failed') + ': ' + String(error), true);
  } finally {
    anchor.textContent = priorText;
    anchor.removeAttribute('aria-busy');
    busyAnchors.delete(anchor);
  }
}
const nativeAnchorClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  if (downloadKind(this)) { void handleDownload(this); return; }
  nativeAnchorClick.call(this);
};
document.addEventListener('click', event => {
  const target = event.target;
  const anchor = target instanceof Element ? target.closest('a') : null;
  if (!(anchor instanceof HTMLAnchorElement)) return;
  if (downloadKind(anchor)) {
    event.preventDefault();
    event.stopPropagation();
    void handleDownload(anchor);
    return;
  }
  if (anchor.href.startsWith('https://github.com/301zrg/specials/tree/master/706')) {
    event.preventDefault();
    window.desktopUpdateScripts();
    return;
  }
  if (/^https?:/.test(anchor.protocol) && anchor.origin !== location.origin && tauriAvailable) {
    event.preventDefault();
    void invoke('open_external', { url: anchor.href }).catch(error => toast(String(error), true));
  }
}, true);

function updateIntroButtons() {
  if (location.pathname !== '/intro.html' || !cachedSettings) return;
  const labels: Record<string, string> = {
    host: cachedSettings.server.gameHost,
    port: String(cachedSettings.server.gamePort),
    address: cachedSettings.server.gameHost + ':' + cachedSettings.server.gamePort,
    password: 'TT'
  };
  document.querySelectorAll<HTMLButtonElement>('button[data-copy-connection]').forEach(button => {
    const label = labels[button.dataset.copyConnection || ''];
    if (label && button.textContent !== label) button.textContent = label;
  });
  document.getElementById('updateScriptsShortcut')?.setAttribute('title', msg('update'));
}
function updateDownloadLabels() {
  document.querySelectorAll<HTMLAnchorElement>('a[download]').forEach(anchor => {
    const kind = downloadKind(anchor);
    if (!kind) return;
    anchor.title = msg(kind === 'deck' ? 'openDeck' : 'openReplay');
    if (/^(下载|Download|DL|リプレイDL|다운로드)$/i.test((anchor.textContent || '').trim())) {
      const label = msg(kind === 'deck' ? 'openDeck' : 'openReplay');
      if (anchor.textContent !== label) anchor.textContent = label;
    }
  });
  const shortcut = document.getElementById('updateScriptsShortcut');
  if (shortcut && shortcut.textContent !== msg('update')) shortcut.textContent = msg('update');
}
document.addEventListener('DOMContentLoaded', () => {
  updateIntroButtons();
  updateDownloadLabels();
  const observer = new MutationObserver(() => { updateIntroButtons(); updateDownloadLabels(); });
  observer.observe(document.body, { childList: true, subtree: true });
});

async function requireName(): Promise<Settings | null> {
  const settings = cachedSettings || await settingsPromise;
  if (settings.player.launchName.trim()) return settings;
  toast(msg('setName'), true);
  window.setTimeout(() => { location.href = '/settings.html#launchName'; }, 700);
  return null;
}
async function launch(kind: 'regular' | 'ladder') {
  try {
    if (!(await requireName())) return;
    await invoke('launch_game', { kind, roomName: null });
  } catch (error) { toast(msg('failed') + ': ' + String(error), true); }
}

async function copyIntroValue(button: HTMLButtonElement): Promise<void> {
  try {
    const field = button.dataset.copyConnection;
    let value = button.dataset.copyValue;
    if (field) {
      const settings = cachedSettings || await settingsPromise;
      const values: Record<string, string> = {
        host: settings.server.gameHost,
        port: String(settings.server.gamePort),
        address: settings.server.gameHost + ':' + settings.server.gamePort,
        password: 'TT'
      };
      value = values[field];
    }
    if (!value) throw new Error('No value to copy');
    if (tauriAvailable) await writeText(value);
    else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else throw new Error('Clipboard is unavailable');
    toast(msg('copied') + value);
  } catch (error) {
    toast(msg('failed') + ': ' + String(error), true);
  }
}

document.addEventListener('click', event => {
  const target = event.target;
  const button = target instanceof Element ? target.closest('button') : null;
  if (!(button instanceof HTMLButtonElement) || !button.closest('[data-i18n="content1"], [data-i18n="content2"], [data-i18n="server_intro_qq"]')) return;
  if (button.hasAttribute('data-copy-connection') || button.hasAttribute('data-copy-value')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void copyIntroValue(button);
    return;
  }
  const kind = button.dataset.desktopLaunch;
  if (kind === 'regular' || kind === 'ladder') {
    event.preventDefault();
    event.stopImmediatePropagation();
    void launch(kind);
  }
}, true);

const progressCallbacks = new Set<(progress: ScriptProgress) => void>();
if (tauriAvailable) {
  void listen<ScriptProgress>('script-progress', event => {
    for (const callback of progressCallbacks) callback(event.payload);
  });
}

window.SrvproDesktop = {
  settings: async () => cachedSettings || await settingsPromise,
  async saveSettings(settings) {
    const saved = await invoke<Settings>('save_settings', { settings });
    cachedSettings = saved;
    localStorage.setItem('srvprotianti.language', saved.ui.language);
    updateIntroButtons();
    return saved;
  },
  async resetSettings() {
    const saved = await invoke<Settings>('reset_settings');
    cachedSettings = saved;
    localStorage.setItem('srvprotianti.language', saved.ui.language);
    updateIntroButtons();
    return saved;
  },
  setLanguage(language) {
    localStorage.setItem('srvprotianti.language', language);
    if (cachedSettings) cachedSettings.ui.language = language;
    if (tauriAvailable) void invoke('set_language', { language }).catch(error => toast(String(error), true));
  },
  regular: () => launch('regular'),
  ladder: () => launch('ladder'),
  async watchRoom(room) {
    try {
      if (!(await requireName())) return;
      const response = await apiFetch('/api/public/rooms?t=' + Date.now());
      const list = (await response.json()).rooms as Record<string, unknown>[];
      const current = list.find(item =>
        String(item.roomid) === String(room.roomid) && item.roomname === room.roomname
      );
      if (!current) throw new Error(msg('roomGone'));
      if (current.needpass !== 'false' || typeof current.istart !== 'string' ||
          !current.istart.startsWith('Duel:') || !current.roomname) {
        throw new Error(msg('roomLocked'));
      }
      await invoke('launch_game', { kind: 'watch', roomName: current.roomname });
    } catch (error) { toast(msg('failed') + ': ' + String(error), true); }
  },
  scriptState: () => invoke('script_state'),
  updateScripts: overwriteConflicts => invoke('update_scripts', { overwriteConflicts }),
  restoreScripts: () => invoke('restore_scripts'),
  onScriptProgress(callback) { progressCallbacks.add(callback); }
};
window.desktopRegular = () => { void window.SrvproDesktop.regular(); };
window.desktopLadder = () => { void window.SrvproDesktop.ladder(); };
window.desktopUpdateScripts = () => { location.href = '/settings.html?update=1#scripts'; };
