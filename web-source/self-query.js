(function(global){
  'use strict';
  var TEXT={
    zh:{self:'查询自己',ranking:'查询我的天梯排行',stats:'查询我的玩家战绩',help:'使用设置中已保存的游戏登录串查询。',missing:'请先在设置中填写并保存游戏登录串。'},
    ja:{self:'自分を検索',ranking:'自分のランキング',stats:'自分の戦績',help:'設定に保存済みのログイン名を使用します。',missing:'設定でログイン名を入力して保存してください。'},
    en:{self:'Find me',ranking:'My ladder ranking',stats:'My player statistics',help:'Uses the game login string saved in Settings.',missing:'Enter and save your game login string in Settings first.'},
    ko:{self:'내 정보 조회',ranking:'내 랭킹 조회',stats:'내 전적 조회',help:'설정에 저장된 게임 로그인 문자열을 사용합니다.',missing:'설정에서 게임 로그인 문자열을 입력하고 저장하세요.'}
  };
  function t(key){return(TEXT[global.SrvproWeb.getLanguage()]||TEXT.zh)[key];}
  async function savedName(){
    var settings=await global.SrvproDesktop.settings(), raw=settings.player.launchName.trim();
    if(!raw.split('$')[0].trim()){global.alert(t('missing'));return null;}
    return raw;
  }
  async function query(){
    var raw=await savedName();if(raw===null)return;
    if(location.pathname.endsWith('/ladder.html')){
      document.getElementById('searchInput').value=raw.split('$')[0].trim();global.doSearch();
    }else{
      document.getElementById('playerInput').value=raw;global.parseInput();
    }
  }
  function open(page){
    return savedName().then(function(raw){
      if(raw===null)return;
      var lang=global.SrvproWeb.getLanguage();location.href='/'+page+'.html?self=1'+(lang==='zh'?'':'&L='+encodeURIComponent(lang));
    });
  }
  function init(){
    var isSettings=location.pathname.endsWith('/settings.html'), path=location.pathname;
    if(!isSettings&&!/\/(ladder|player-stats)\.html$/.test(path))return;
    var host=isSettings?document.getElementById('save').parentElement:document.querySelector('.search-row,.web-controls');
    function append(node){if(isSettings)host.insertBefore(node,document.getElementById('configStatus'));else host.appendChild(node);}
    function button(key,callback){var node=document.createElement('button');node.type='button';node.dataset.selfQuery=key;node.onclick=function(){void callback().catch(function(){global.alert(t('missing'));});};append(node);return node;}
    var nodes=[];
    if(isSettings){nodes.push([button('ranking',function(){return open('ladder');}),'ranking'],[button('stats',function(){return open('player-stats');}),'stats']);}
    else nodes.push([button('self',query),'self']);
    var help=document.createElement(isSettings?'p':'span');help.className='muted';append(help);
    function labels(){nodes.forEach(function(pair){pair[0].textContent=t(pair[1]);});help.textContent=t('help');}
    labels();document.addEventListener('srvpro-language-change',labels);
    if(!isSettings&&new URLSearchParams(location.search).get('self')==='1'){
      var url=new URL(location.href);url.searchParams.delete('self');history.replaceState(null,'',url);
      void query().catch(function(){global.alert(t('missing'));});
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(window);
