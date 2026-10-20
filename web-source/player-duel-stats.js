(function (global) {
  'use strict';
  var TEXT = {
    zh:{title:'详细对局统计',expand:'展开统计',collapse:'收起统计',month:'月份',all:'全部',deck:'使用卡组',allDecks:'全部卡组',
      loading:'正在加载统计…',pending:'详细统计暂不可用，请稍后重试。',failed:'统计加载失败，请重试。',busy:'请求较多，请稍后重试。',
      hint:'仅统计满足统计条件的可追溯对局，样本数可能少于累计战绩。',download:'下载所选时期全部指标（CSV）',
      opponent:'对手卡组',overall:'综合',first:'先攻',second:'后攻',empty:'暂无统计数据',tabs:['Match','单局','主牌局','备牌局'],
      replays:'录像',replayPending:'录像功能暂不可用',downloadReplay:'下载录像',play:'网页播放',search:'搜索录像'},
    ja:{title:'詳細対戦統計',expand:'統計を開く',collapse:'統計を閉じる',month:'月',all:'全期間',deck:'使用デッキ',allDecks:'全デッキ',
      loading:'統計を読み込み中…',pending:'詳細統計は現在利用できません。後で再試行してください。',failed:'読み込みに失敗しました。再試行してください。',busy:'リクエストが多いため後で再試行してください。',
      hint:'追跡可能で統計条件を満たす対戦のみ集計するため、累計戦績より標本数が少ない場合があります。',download:'選択期間の全指標を保存（CSV）',
      opponent:'対戦デッキ',overall:'総合',first:'先攻',second:'後攻',empty:'統計データなし',tabs:['マッチ','ゲーム','メイン','サイド'],
      replays:'リプレイ',replayPending:'リプレイは現在利用できません',downloadReplay:'保存',play:'Web再生',search:'リプレイを検索'},
    en:{title:'Detailed duel statistics',expand:'Show statistics',collapse:'Hide statistics',month:'Month',all:'All time',deck:'Player deck',allDecks:'All decks',
      loading:'Loading statistics…',pending:'Detailed statistics are temporarily unavailable. Please retry later.',failed:'Failed to load statistics. Please retry.',busy:'Too many requests. Please retry shortly.',
      hint:'Only traceable duels meeting the statistical criteria are counted. Samples may be fewer than the cumulative record.',download:'Download selected period: all metrics (CSV)',
      opponent:'Opponent deck',overall:'Overall',first:'Going first',second:'Going second',empty:'No statistics',tabs:['Match','Game','Pre-side game','Post-side game'],
      replays:'Replays',replayPending:'Replays are temporarily unavailable',downloadReplay:'Download replay',play:'Play in web',search:'Search replays'},
    ko:{title:'상세 대전 통계',expand:'통계 펼치기',collapse:'통계 접기',month:'월',all:'전체',deck:'사용 덱',allDecks:'모든 덱',
      loading:'통계 로딩 중…',pending:'상세 통계를 일시적으로 사용할 수 없습니다. 나중에 다시 시도하세요.',failed:'통계를 불러오지 못했습니다. 다시 시도하세요.',busy:'요청이 많습니다. 잠시 후 다시 시도하세요.',
      hint:'추적 가능하고 집계 조건을 충족하는 대전만 포함하므로 표본 수가 누적 전적보다 적을 수 있습니다.',download:'선택 기간 전체 지표 저장(CSV)',
      opponent:'상대 덱',overall:'종합',first:'선공',second:'후공',empty:'통계 없음',tabs:['매치','단판','메인전','사이드전'],
      replays:'리플레이',replayPending:'리플레이를 일시적으로 사용할 수 없습니다',downloadReplay:'리플레이 다운로드',play:'웹 재생',search:'리플레이 검색'}
  };
  var state=null, root=null, identity='', scope='month', selectedDeck='', tab=0, expanded=false, value=null, status='', serial=0, loading=false,exporting=false,format='xlsx';
  function t(key){return (TEXT[global.SrvproWeb.getLanguage()]||TEXT.zh)[key];}
  function esc(text){return String(text==null?'':text).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function deckLink(deck){
    var name=esc(global.SrvproStatsExport.local(deck.names)), id=Number(deck.deckTypeId), lang=global.SrvproWeb.getLanguage();
    if(!Number.isInteger(id)||id<=0||id===4095)return name;
    var href='/deck-detail.html?deckTypeId='+id+'&period='+scope+'&month='+encodeURIComponent(state.month)+(lang==='zh'?'':'&L='+encodeURIComponent(lang));
    return '<a class="inline-link" href="'+esc(href)+'">'+name+'</a>';
  }
  function rate(values, metric){
    var count=Number(values&&values[metric[1]]||0), wins=Number(values&&values[metric[2]]||0);
    if(!count)return '—';
    var percent=wins/count*100, classes=global.SrvproWeb.rateClass;
    return '<div class="rate-cell"><strong '+(classes?'class="'+classes(percent)+'"':'style="color:'+global.SrvproWeb.rateColor(percent)+'"')+'>'+percent.toFixed(2)+'%</strong><small>'+wins+' / '+count+'</small></div>';
  }
  function draw(){
    if(!root||!state||!state.authenticated)return;
    var html='<div class="private-stat-heading"><h2>'+t('title')+'</h2><button type="button" class="web-button" data-private-expand aria-expanded="'+expanded+'">'+t(expanded?'collapse':'expand')+'</button></div>';
    if(expanded){
      html+='<div class="web-controls"><div class="web-tabs"><button type="button" data-private-scope="month" class="'+(scope==='month'?'active':'')+'">'+t('month')+' '+esc(state.month.slice(0,4)+'-'+state.month.slice(4))+'</button><button type="button" data-private-scope="all" class="'+(scope==='all'?'active':'')+'">'+t('all')+'</button></div>';
      if(value){
        html+='<label>'+t('deck')+' <select data-private-deck><option value="">'+t('allDecks')+'</option>'+(value.decks||[]).map(function(deck){return '<option value="'+deck.deckTypeId+'" '+(String(deck.deckTypeId)===selectedDeck?'selected':'')+'>'+esc(global.SrvproStatsExport.local(deck.names))+'</option>';}).join('')+'</select></label><button type="button" data-private-csv>'+t('download')+'</button>';
      }
      html+='</div><p class="muted">'+t('hint')+'</p>';
      if(loading||!value)html+='<p class="empty-state" role="status">'+t(loading?'loading':status||'pending')+'</p>';
      else{
        var selected=selectedDeck?(value.decks||[]).find(function(deck){return String(deck.deckTypeId)===selectedDeck;}):value;
        if(!selected){selectedDeck='';selected=value;}
        var metrics=global.SrvproStatsExport.metrics.slice(tab*3,tab*3+3), rows=[{names:null,values:selected.overall}].concat(selected.opponents||[]);
        if(selected.names)html+='<p data-private-own-deck>'+deckLink(selected)+'</p>';
        html+='<div class="web-tabs">'+t('tabs').map(function(name,index){return '<button type="button" data-private-tab="'+index+'" class="'+(tab===index?'active':'')+'">'+name+'</button>';}).join('')+'</div><div class="table-wrap"><table><thead><tr><th>'+t('opponent')+'</th>'+['overall','first','second'].map(function(key){return '<th>'+t(key)+'</th>';}).join('')+'</tr></thead><tbody>'+
          rows.map(function(row){return '<tr><th>'+(row.names?deckLink(row):global.SrvproStatsExport.t('all'))+'</th>'+metrics.map(function(metric){return '<td>'+rate(row.values,metric)+'</td>';}).join('')+'</tr>';}).join('')+'</tbody></table></div>';
      }
    }
    root.innerHTML=html;
    root.querySelector('[data-private-expand]').onclick=function(){expanded=!expanded;draw();if(expanded&&!value&&!loading)load();};
    root.querySelectorAll('[data-private-scope]').forEach(function(button){button.onclick=function(){if(scope===button.dataset.privateScope)return;scope=button.dataset.privateScope;value=null;selectedDeck='';load();};});
    var select=root.querySelector('[data-private-deck]');if(select)select.onchange=function(){selectedDeck=select.value;draw();};
    root.querySelectorAll('[data-private-tab]').forEach(function(button){button.onclick=function(){tab=Number(button.dataset.privateTab);draw();};});
    var download=root.querySelector('[data-private-csv]');if(download){
      download.textContent=t('download').replace('CSV',format==='csv'?'CSV':'XLSX');
      download.before(global.SrvproStatsExport.formatPicker(format,function(next){format=next;draw();}));
      download.disabled=exporting;
      download.onclick=async function(){
      if(exporting)return;exporting=true;
      var snapshot=value, lang=global.SrvproWeb.getLanguage(),selectedFormat=format;download.disabled=true;
      try{
        var filename='srvpro-player-stats-'+(snapshot.scope==='month'?snapshot.month:'all')+'.'+selectedFormat;
        if(selectedFormat==='csv')await global.SrvproStatsExport.save(filename,global.SrvproStatsExport.playerRows(snapshot,lang));
        else await global.SrvproStatsExport.saveWorkbook(filename,'player',snapshot,lang);
      }
      catch(error){global.alert(global.SrvproStatsExport.t('failed',lang));}
      finally{exporting=false;download.disabled=false;var current=root&&root.querySelector('[data-private-csv]');if(current)current.disabled=false;}
    };}
  }
  async function load(){
    var request=++serial, body=JSON.stringify({player:state.player,password:state.password,scope:scope,month:state.month});
    loading=true;value=null;status='';draw();
    try{
      var response=await fetch('/api/ladder/player/stats',{method:'POST',headers:{'Content-Type':'application/json'},body:body});
      if(request!==serial)return;
      if(response.status===403){state.authenticated=false;root.hidden=true;return;}
      if(response.status===404||response.status===501){status='pending';return;}
      if(response.status===429){status='busy';return;}
      if(!response.ok)throw Error();
      var data=await response.json();if(request!==serial)return;
      if(data.available!==true||!data.overall||!Array.isArray(data.decks)){status='pending';return;}
      value=data;
    }catch(error){if(request===serial)status='failed';}
    finally{if(request===serial){loading=false;draw();}}
  }
  function mount(next){
    var nextIdentity=next.player+'\0'+next.password+'\0'+next.month;
    if(identity!==nextIdentity){serial++;identity=nextIdentity;expanded=false;value=null;selectedDeck='';scope='month';tab=0;loading=false;status='';}
    state=next;
    if(!next.authenticated){serial++;value=null;expanded=false;loading=false;return;}
    root=document.createElement('section');root.className='web-card private-duel-stats';root.id='privateDuelStats';
    var main=document.getElementById('content');main.insertBefore(root,main.children[1]||null);draw();
  }
  function clear(){serial++;value=null;expanded=false;loading=false;identity='';if(root)root.remove();root=null;}
  function replayCell(match){
    if(!Array.isArray(match.replays))return '<span class="muted feature-placeholder">'+t('replayPending')+'</span>';
    if(!match.replays.length)return '—';
    return match.replays.filter(function(replay){return /^\/api\/public\/replay\//.test(replay.url||'')&&Number.isInteger(Number(replay.duelCount));}).map(function(replay){
      return '<div class="replay-actions"><span>G'+Number(replay.duelCount)+'</span><a class="inline-link" href="'+esc(replay.url)+'" download="'+esc(replay.filename)+'">'+t('downloadReplay')+'</a>'+
        (global.SrvproDesktop?'':'<button type="button" data-profile-replay="'+esc(replay.url)+'" data-filename="'+esc(replay.filename)+'">'+t('play')+'</button>')+'</div>';
    }).join('');
  }
  document.addEventListener('click',function(event){
    var button=event.target.closest&&event.target.closest('[data-profile-replay]');
    if(button&&global.SrvproReplayWeb)global.SrvproReplayWeb.open(button,button.dataset.profileReplay,button.dataset.filename);
  });
  global.SrvproPlayerDetails={mount:mount,clear:clear,t:t,replayCell:replayCell};
})(window);
