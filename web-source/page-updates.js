(function(global){
  'use strict';
  var TEXT={
    zh:{title:'页面更新',version:'当前页面版本：',builtin:'内置页面',check:'检查页面更新',recover:'下次启动使用内置页面',checking:'正在检查页面更新……',current:'当前页面可用。',staged:'新版页面已下载，将在下次启动时应用。',unavailable:'页面更新暂不可用，继续使用当前版本。',rejected:'页面更新校验失败，已保留当前版本。',recovered:'下次启动使用内置页面'},
    ja:{title:'ページ更新',version:'現在のページバージョン：',builtin:'内蔵ページ',check:'ページ更新を確認',recover:'次回起動時に内蔵ページを使用',checking:'ページ更新を確認しています…',current:'現在のページを利用できます。',staged:'新しいページをダウンロードしました。次回起動時に適用します。',unavailable:'ページ更新を確認できません。現在のページを引き続き使用します。',rejected:'ページ更新を検証できませんでした。現在のページを保持します。',recovered:'次回起動時に内蔵ページを使用'},
    en:{title:'Page updates',version:'Current page version: ',builtin:'Built-in pages',check:'Check page updates',recover:'Use built-in pages on next launch',checking:'Checking page updates…',current:'The current pages are available.',staged:'New pages downloaded. They will apply on the next launch.',unavailable:'Page updates are unavailable. The current pages remain in use.',rejected:'Page update verification failed. The current pages were kept.',recovered:'Use built-in pages on next launch'},
    ko:{title:'페이지 업데이트',version:'현재 페이지 버전: ',builtin:'기본 페이지',check:'페이지 업데이트 확인',recover:'다음 실행 시 기본 페이지 사용',checking:'페이지 업데이트 확인 중…',current:'현재 페이지를 사용할 수 있습니다.',staged:'새 페이지를 다운로드했습니다. 다음 실행 시 적용됩니다.',unavailable:'페이지를 업데이트할 수 없습니다. 현재 페이지를 계속 사용합니다.',rejected:'페이지 업데이트 검증에 실패했습니다. 현재 페이지를 유지합니다.',recovered:'다음 실행 시 기본 페이지 사용'}
  };
  var mounted=false,last={status:'current',currentVersion:'builtin'},busy=false;
  function text(){return TEXT[global.SrvproWeb.getLanguage()]||TEXT.zh;}
  function node(id){return document.getElementById(id);}
  function render(value){
    if(value&&typeof value==='object')last=value;
    var t=text(),status=Object.prototype.hasOwnProperty.call(t,last.status)?last.status:'unavailable';
    node('pageUpdateTitle').textContent=t.title;
    node('pageUpdateVersion').textContent=t.version+(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(last.currentVersion)?last.currentVersion:t.builtin);
    node('checkPageUpdate').textContent=t.check;
    node('recoverBuiltinPages').textContent=t.recover;
    node('pageUpdateStatus').textContent=t[status];
  }
  async function run(method){
    if(busy)return;
    busy=true;node('checkPageUpdate').disabled=true;node('recoverBuiltinPages').disabled=true;
    render(Object.assign({},last,{status:'checking'}));
    try{render(await global.SrvproDesktop[method]());}
    catch(_){render(Object.assign({},last,{status:'unavailable'}));}
    finally{busy=false;node('checkPageUpdate').disabled=false;node('recoverBuiltinPages').disabled=false;}
  }
  async function mount(){
    if(mounted||!node('page-update')||!global.SrvproDesktop)return;
    mounted=true;
    node('checkPageUpdate').addEventListener('click',function(){return run('checkPageUpdate');});
    node('recoverBuiltinPages').addEventListener('click',function(){return run('recoverBuiltinPages');});
    document.addEventListener('srvpro-language-change',function(){render();});
    document.addEventListener('srvpro-page-update',function(event){render(event.detail);});
    render();
    try{render(await global.SrvproDesktop.pageUpdateStatus());}
    catch(_){render(Object.assign({},last,{status:'unavailable'}));}
  }
  global.SrvproPageUpdates={mount:mount};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else void mount();
})(window);
