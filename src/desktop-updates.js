(function(global){
  'use strict';
  const TEXT={
    zh:{title:'助手更新',help:'检查最新正式版。下载后关闭游戏和助手，将 ZIP 解压覆盖到游戏根目录，并保留 srvprotianti-desktop-data 文件夹。',check:'检查助手更新',download:'下载此版本',manual:'打开官方下载页',checking:'正在检查更新……',versions:'当前版本：%current% · 最新检查版本：%latest%',current:'当前版本不低于最新已发布版本。',available:'发现新版本，可在浏览器中下载。',checked:'检查时间：',cached:'缓存检查时间：',stale:'以下为上次检查结果，尚未确认目前最新版本。',retry:'可重试时间：',opening:'已在浏览器中打开下载地址。',network:'暂时无法连接更新来源，请检查网络后重试，或打开官方下载页。',rate_limited:'更新来源暂时限制请求，请稍后重试，或打开官方下载页。',access_denied:'更新来源暂时拒绝访问，请稍后重试，或打开官方下载页。',missing_manifest:'正式版暂未提供版本清单，请打开官方下载页查看。',invalid_manifest:'版本信息校验失败，请稍后重试，或打开官方下载页。',server:'更新服务暂不可用，请稍后重试，或打开官方下载页。'},
    ja:{title:'アシスタントの更新',help:'最新正式版を確認します。ダウンロード後にゲームとアシスタントを終了し、ZIPをゲームのルートに展開して上書きしてください。srvprotianti-desktop-dataは残してください。',check:'更新を確認',download:'このバージョンをダウンロード',manual:'公式ダウンロードページ',checking:'更新を確認中…',versions:'現在：%current% · 最終確認版：%latest%',current:'現在のバージョンは公開済みの最新版以降です。',available:'新版が見つかりました。ブラウザーでダウンロードできます。',checked:'確認時刻：',cached:'キャッシュの確認時刻：',stale:'前回の確認結果です。現在の最新版は未確認です。',retry:'再試行できる時刻：',opening:'ブラウザーでダウンロード先を開きました。',network:'更新元に接続できません。接続を確認して再試行するか、公式ページを開いてください。',rate_limited:'更新元のリクエスト制限です。後で再試行するか、公式ページを開いてください。',access_denied:'更新元へのアクセスが拒否されました。後で再試行するか、公式ページを開いてください。',missing_manifest:'正式版のバージョン情報はまだありません。公式ページを開いてください。',invalid_manifest:'バージョン情報を検証できません。後で再試行するか、公式ページを開いてください。',server:'更新サービスを利用できません。後で再試行するか、公式ページを開いてください。'},
    en:{title:'Assistant updates',help:'Check the latest stable release. After downloading, close the game and assistant, extract the ZIP over the game root, and keep the srvprotianti-desktop-data folder.',check:'Check for updates',download:'Download this version',manual:'Open official downloads',checking:'Checking for updates…',versions:'Current: %current% · Last checked version: %latest%',current:'Your version is at least as new as the latest published release.',available:'A new version is available to download in your browser.',checked:'Checked at: ',cached:'Cached check time: ',stale:'Showing the previous result. The latest version has not been confirmed.',retry:'Retry after: ',opening:'Opened the download in your browser.',network:'Cannot connect to the update source. Check your connection and retry, or open official downloads.',rate_limited:'The update source is limiting requests. Retry later or open official downloads.',access_denied:'The update source denied access. Retry later or open official downloads.',missing_manifest:'This release has no version manifest yet. Open official downloads.',invalid_manifest:'Version information could not be validated. Retry later or open official downloads.',server:'The update service is unavailable. Retry later or open official downloads.'},
    ko:{title:'도우미 업데이트',help:'최신 정식 버전을 확인합니다. 다운로드 후 게임과 도우미를 종료하고 ZIP을 게임 루트에 덮어쓰되 srvprotianti-desktop-data 폴더는 보존하세요.',check:'업데이트 확인',download:'이 버전 다운로드',manual:'공식 다운로드 페이지',checking:'업데이트 확인 중…',versions:'현재: %current% · 마지막 확인 버전: %latest%',current:'현재 버전은 최신 공개 버전 이상입니다.',available:'브라우저에서 새 버전을 다운로드할 수 있습니다.',checked:'확인 시각: ',cached:'캐시 확인 시각: ',stale:'이전 확인 결과입니다. 현재 최신 버전은 확인되지 않았습니다.',retry:'재시도 가능 시각: ',opening:'브라우저에서 다운로드 주소를 열었습니다.',network:'업데이트 서버에 연결할 수 없습니다. 연결을 확인하거나 공식 다운로드 페이지를 여세요.',rate_limited:'업데이트 요청이 제한되었습니다. 나중에 재시도하거나 공식 다운로드 페이지를 여세요.',access_denied:'업데이트 서버가 접근을 거부했습니다. 나중에 재시도하거나 공식 페이지를 여세요.',missing_manifest:'아직 버전 정보가 없습니다. 공식 다운로드 페이지를 여세요.',invalid_manifest:'버전 정보를 검증할 수 없습니다. 나중에 재시도하거나 공식 페이지를 여세요.',server:'업데이트 서비스를 사용할 수 없습니다. 나중에 재시도하거나 공식 페이지를 여세요.'}
  };
  let mounted=false,busy=false,last=null;
  const node=id=>document.getElementById(id);
  const text=()=>TEXT[global.SrvproWeb.getLanguage()]||TEXT.en;
  const errorCode=error=>/temporarily limited|rate.limit/i.test(String(error))?'rate_limited':'network';
  function render(){
    const t=text(),bad=last&&(last.status==='stale'||last.status==='unavailable');
    node('desktopUpdateTitle').textContent=t.title;node('desktopUpdateHelp').textContent=t.help;
    node('checkDesktopUpdate').textContent=t.check;node('downloadDesktopUpdate').textContent=t.download;
    const manual=node('desktopUpdateManual');manual.textContent=t.manual;manual.hidden=false;
    manual.href='https://github.com/301zrg/srvprotianti-desktop/releases/latest';
    node('desktopUpdateVersion').textContent=last?.latestVersion?t.versions.replace('%current%',last.currentVersion).replace('%latest%',last.latestVersion):'';
    const times=[];
    if(last?.checkedAt)times.push((last.status==='cached'?t.cached:t.checked)+new Date(last.checkedAt*1000).toLocaleString());
    if(last?.retryAt)times.push(t.retry+new Date(last.retryAt*1000).toLocaleString());
    node('desktopUpdateTime').textContent=times.join(' · ');
    node('downloadDesktopUpdate').hidden=!last?.updateAvailable||!last.downloadUrl;
    node('downloadDesktopUpdate').disabled=busy;
    const status=node('desktopUpdateStatus');
    status.className='status '+(bad?'error':'success');
    status.textContent=busy?t.checking:!last?'':bad?(t[last.error]||t.network)+(last.latestVersion?' '+t.stale:''):last.updateAvailable?t.available:t.current;
  }
  async function check(){
    if(busy)return;busy=true;node('checkDesktopUpdate').disabled=true;render();
    try{last=await global.SrvproDesktop.checkDesktopUpdate();}
    catch(error){last=error&&typeof error==='object'&&['stale','unavailable'].includes(error.status)?error:Object.assign({},last,{status:last?.latestVersion?'stale':'unavailable',error:errorCode(error)});}
    finally{busy=false;node('checkDesktopUpdate').disabled=false;render();}
  }
  function mount(){
    if(mounted||!node('desktop-update')||!global.SrvproDesktop)return;mounted=true;
    node('checkDesktopUpdate').addEventListener('click',check);
    node('downloadDesktopUpdate').addEventListener('click',async()=>{
      if(busy||!last?.downloadUrl)return;
      try{await global.SrvproDesktop.openUpdateDownload(last.downloadUrl);node('desktopUpdateStatus').textContent=text().opening;}
      catch(_){node('desktopUpdateStatus').textContent=text().network;}
    });
    document.addEventListener('srvpro-language-change',render);render();
  }
  global.SrvproDesktopUpdates={mount};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})(window);
