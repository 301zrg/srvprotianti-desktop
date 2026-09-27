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
    '点击下列任一地址按钮，会启动游戏并预填昵称、服务器地址与端口。进入游戏后请自行选择联机；<a href="https://ygo233.com/usage" target="_blank" rel="noopener">常规房间密码规则</a>与网页相同。',
    '点击下列任一按钮，会以当前登录串直接加入天梯 TT。请在设置中填写“昵称$密码”；新 ID 首次使用时由服务器注册。<a href="https://www.bilibili.com/opus/1242727870611062788" target="_blank" rel="noopener">天梯教程</a>。'
  ],
  ja: [
    '次のいずれかのボタンでゲームを起動し、名前・ホスト・ポートを設定します。接続操作はゲーム内で行ってください。<a href="https://ygo233.com/usage" target="_blank" rel="noopener">ルームパスワードの説明</a>。',
    '次のいずれかのボタンで TT ランク戦に参加します。設定で「名前$パスワード」を入力してください。新しい ID はサーバーで登録されます。<a href="https://www.bilibili.com/opus/1242727870611062788" target="_blank" rel="noopener">説明</a>。'
  ],
  en: [
    'Click any address button to launch the game with your name, host and port filled in. Connect from inside the game. <a href="https://ygo233.com/usage" target="_blank" rel="noopener">Room password guide</a>.',
    'Click any button below to join TT. Set your “name$password” login string in Settings first. The server registers a new ID on first use. <a href="https://www.bilibili.com/opus/1242727870611062788" target="_blank" rel="noopener">TT guide</a>.'
  ],
  ko: [
    '아래 주소 버튼을 누르면 이름, 서버 주소, 포트를 입력한 채 게임이 실행됩니다. 게임에서 직접 접속하세요. <a href="https://ygo233.com/usage" target="_blank" rel="noopener">방 비밀번호 안내</a>.',
    '아래 버튼 중 하나를 누르면 TT 랭크전에 참가합니다. 먼저 설정에서 “이름$비밀번호”를 입력하세요. 새 ID는 서버에서 등록됩니다. <a href="https://www.bilibili.com/opus/1242727870611062788" target="_blank" rel="noopener">TT 안내</a>.'
  ]
};

function introMarkup(language, ladder) {
  const type = ladder ? 'desktopLadder' : 'desktopRegular';
  const caption = connectionText[language][ladder ? 1 : 0];
  const labels = ['121.4.34.71', '7911', '121.4.34.71:7911'];
  if (ladder) labels.push('TT');
  return caption + ' ' + labels.map(label =>
    '<button type="button" onclick="' + type + '()">' + label + '</button>'
  ).join(' ');
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
  if (page === 'intro') html = rewriteIntro(html);
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
