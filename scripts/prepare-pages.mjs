import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'web-source');
const publicRoot = path.join(root, 'public');
const assetRoot = path.join(publicRoot, 'assets');
const pageScriptRoot = path.join(assetRoot, 'pages');
const pages = [
  'intro', 'rooms', 'replays', 'ladder', 'deck-stats',
  'player-stats', 'usage-stats', 'deck-detail', 'settings'
];

await mkdir(pageScriptRoot, { recursive: true });
await copyFile(path.join(source, 'site-shell.js'), path.join(assetRoot, 'site-shell.js'));
await copyFile(path.join(source, 'common.css'), path.join(assetRoot, 'common.css'));

const connectionText = {
  zh: [
    '点击数值可复制。启动游戏后会预填设置中的昵称和联机地址，请在游戏内选择连接。<a href="https://ygo233.com/usage" target="_blank" rel="noopener">常规房间密码规则</a>。',
    '点击数值可复制。启动游戏会使用设置中的“昵称$密码”直接加入天梯 TT；新 ID 首次使用时由服务器注册。<a href="https://www.bilibili.com/opus/1242727870611062788" target="_blank" rel="noopener">天梯教程</a>。'
  ],
  ja: [
    '数値をクリックするとコピーできます。ゲームを起動すると設定済みの名前と接続先が入力されます。接続はゲーム内で行ってください。<a href="https://ygo233.com/usage" target="_blank" rel="noopener">ルームパスワードの説明</a>。',
    '数値をクリックするとコピーできます。ゲームを起動すると設定済みの「名前$パスワード」で TT に直接参加します。新しい ID はサーバーで登録されます。<a href="https://www.bilibili.com/opus/1242727870611062788" target="_blank" rel="noopener">説明</a>。'
  ],
  en: [
    'Click a value to copy it. Launching the game fills in your saved name and server address; connect inside the game. <a href="https://ygo233.com/usage" target="_blank" rel="noopener">Room password guide</a>.',
    'Click a value to copy it. Launching the game joins TT with your saved “name$password” login. The server registers a new ID on first use. <a href="https://www.bilibili.com/opus/1242727870611062788" target="_blank" rel="noopener">TT guide</a>.'
  ],
  ko: [
    '값을 클릭하면 복사됩니다. 게임을 실행하면 저장된 이름과 서버 주소가 입력됩니다. 접속은 게임 안에서 진행하세요. <a href="https://ygo233.com/usage" target="_blank" rel="noopener">방 비밀번호 안내</a>.',
    '값을 클릭하면 복사됩니다. 게임을 실행하면 저장된 “이름$비밀번호”로 TT에 바로 참가합니다. 새 ID는 서버에서 등록됩니다. <a href="https://www.bilibili.com/opus/1242727870611062788" target="_blank" rel="noopener">TT 안내</a>.'
  ]
};

const connectionLabels = {
  zh: { host: '服务器 IP：', port: '端口：', address: 'IP 与端口：', password: '房间密码：', regular: '启动游戏', ladder: '启动并加入天梯' },
  ja: { host: 'サーバー IP：', port: 'ポート：', address: 'IP とポート：', password: 'ルームパスワード：', regular: 'ゲームを起動', ladder: '起動して TT に参加' },
  en: { host: 'Server IP:', port: 'Port:', address: 'IP and port:', password: 'Room password:', regular: 'Launch game', ladder: 'Launch and join TT' },
  ko: { host: '서버 IP:', port: '포트:', address: 'IP와 포트:', password: '방 비밀번호:', regular: '게임 실행', ladder: '실행 후 TT 참가' }
};

function introMarkup(language, ladder) {
  const caption = connectionText[language][ladder ? 1 : 0];
  const labels = connectionLabels[language];
  const kind = ladder ? 'ladder' : 'regular';
  const fields = [
    ['host', '121.4.34.71'],
    ['port', '7911'],
    ['address', '121.4.34.71:7911']
  ];
  if (ladder) fields.push(['password', 'TT']);
  const buttons = fields.map(([field, value]) =>
    '<span class="connection-field">' + labels[field] + ' <button type="button" data-copy-connection="' + field + '">' + value + '</button></span>'
  ).join(' ');
  return caption + '<br>' + buttons +
    ' <button type="button" class="desktop-launch-button" data-desktop-launch="' + kind + '">' + labels[kind] + '</button>';
}

function rewriteIntro(html) {
  for (const [index, key] of ['content1', 'content2'].entries()) {
    const ladder = index === 1;
    html = html.replace(
      new RegExp('(<p data-i18n="' + key + '">)[\\s\\S]*?(</p>)'),
      (_, open, close) => open + introMarkup('zh', ladder) + close
    );
    let language = 'zh';
    html = html.replace(
      new RegExp('^([ \\t]*' + key + ': )[^\\r\\n]*$', 'gm'),
      (_, prefix) => {
        const result = prefix + JSON.stringify(introMarkup(language, ladder)) + ',';
        language = { zh: 'ja', ja: 'en', en: 'ko', ko: 'zh' }[language];
        return result;
      }
    );
  }
  return html;
}

for (const page of pages) {
  const sourcePath = page === 'settings'
    ? path.join(root, 'settings.html')
    : path.join(source, page + '.html');
  let html = await readFile(sourcePath, 'utf8');
  if (page === 'intro') {
    html = rewriteIntro(html);
    html = html.replaceAll(
      "onclick=\"copyContent('749717894')\"",
      'data-copy-value="749717894"'
    ).replaceAll(
      String.raw`onclick="copyContent(\'749717894\')"`,
      'data-copy-value="749717894"'
    );
  }
  if (page === 'replays') {
    html = html.replace(
      '<select id="deckFilter"',
      '<button type="button" id="updateScriptsShortcut" onclick="desktopUpdateScripts()"></button>\n  <select id="deckFilter"'
    );
  }
  html = html.replace(
    '<script src="/assets/site-shell.js"></script>',
    '<script src="/assets/desktop-bridge.js"></script>\n<script src="/assets/site-shell.js"></script>'
  );
  const inlineScripts = [];
  html = html.replace(/<script>([\s\S]*?)<\/script>/g, (_, code) => {
    const number = inlineScripts.push(code);
    return '<script src="/assets/pages/' + page + '-' + number + '.js"></script>';
  });
  for (const [index, code] of inlineScripts.entries()) {
    await writeFile(path.join(pageScriptRoot, page + '-' + (index + 1) + '.js'), code, 'utf8');
  }
  await writeFile(path.join(publicRoot, page + '.html'), html, 'utf8');
}
