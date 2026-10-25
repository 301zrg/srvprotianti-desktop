(function (global) {
  'use strict';
  var ZONES=['monster','spell','trap','extra','side'];
  var PERIODS={zh:{today:'本日',week:'本周',month:'月份',all:'全部'},ja:{today:'今日',week:'今週',month:'月',all:'全期間'},en:{today:'Today',week:'This week',month:'Month',all:'All time'},ko:{today:'오늘',week:'이번 주',month:'월',all:'전체'}};
  var TEXT={
    zh:{title:'单卡投入率',show:'展开单卡投入率',hide:'收起单卡投入率',loading:'正在加载单卡投入率…',retry:'重试',failed:'单卡投入率加载失败，请重试。',legacy:'当前服务器暂不支持单卡投入率。',busy:'统计繁忙，请稍后重试。',timeout:'统计超时，请重试。',invalid:'当前卡组或时期不可用。',empty:'本区域暂无卡片。',noSamples:'所选时期暂无有效卡片样本。',coverage:'有效卡片样本 %v% / 全部样本 %a%',hint:'按首局卡组统计；投入率以有效卡片样本为分母。每个区域最多显示及导出前200名，每页50张。',zones:['主卡组怪兽','主卡组魔法','主卡组陷阱','额外卡组','副卡组'],prev:'上一页',next:'下一页',download:'下载所选时期单卡投入率'},
    ja:{title:'カード採用率',show:'カード採用率を表示',hide:'カード採用率を閉じる',loading:'カード採用率を読み込み中…',retry:'再試行',failed:'カード採用率の読み込みに失敗しました。',legacy:'このサーバーはカード採用率に未対応です。',busy:'集計が混雑しています。後で再試行してください。',timeout:'集計がタイムアウトしました。再試行してください。',invalid:'このデッキまたは期間は利用できません。',empty:'この区分のカードはありません。',noSamples:'選択期間の有効カード標本がありません。',coverage:'有効カード標本 %v% / 全標本 %a%',hint:'第1ゲームのデッキを集計し、有効カード標本を分母とします。区分ごとに上位200件まで表示・保存し、1ページ50件です。',zones:['メインのモンスター','メインの魔法','メインの罠','EXデッキ','サイドデッキ'],prev:'前へ',next:'次へ',download:'選択期間のカード採用率を保存'},
    en:{title:'Card adoption',show:'Show card adoption',hide:'Hide card adoption',loading:'Loading card adoption…',retry:'Retry',failed:'Failed to load card adoption. Please retry.',legacy:'This server does not support card adoption yet.',busy:'Statistics are busy. Please retry later.',timeout:'Statistics timed out. Please retry.',invalid:'This deck or period is unavailable.',empty:'No cards in this zone.',noSamples:'No valid card samples for this period.',coverage:'Valid card samples %v% / all samples %a%',hint:'Uses game 1 decks; adoption is divided by valid card samples. Shows and exports up to 200 cards per zone, 50 per page.',zones:['Main deck monsters','Main deck spells','Main deck traps','Extra deck','Side deck'],prev:'Previous',next:'Next',download:'Download selected period card adoption'},
    ko:{title:'카드 투입률',show:'카드 투입률 펼치기',hide:'카드 투입률 접기',loading:'카드 투입률을 불러오는 중…',retry:'다시 시도',failed:'카드 투입률을 불러오지 못했습니다. 다시 시도하세요.',legacy:'현재 서버는 카드 투입률을 지원하지 않습니다.',busy:'통계가 혼잡합니다. 나중에 다시 시도하세요.',timeout:'통계 시간이 초과되었습니다. 다시 시도하세요.',invalid:'현재 덱 또는 기간을 사용할 수 없습니다.',empty:'이 구역에 카드가 없습니다.',noSamples:'선택 기간에 유효한 카드 표본이 없습니다.',coverage:'유효 카드 표본 %v% / 전체 표본 %a%',hint:'첫 게임 덱을 집계하며 유효 카드 표본이 분모입니다. 구역별 상위 200장까지 표시 및 저장하며 페이지당 50장입니다.',zones:['메인 덱 몬스터','메인 덱 마법','메인 덱 함정','엑스트라 덱','사이드 덱'],prev:'이전',next:'다음',download:'선택 기간 카드 투입률 저장'}
  };
  function element(tag,text,className){var node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;}
  function identity(scope){return scope?JSON.stringify([Number(scope.deckId),scope.period,scope.period==='month'?scope.month:null,scope.lang]):'';}
  function create(){
    var api=global.SrvproStatsExport,root=element('section',null,'web-card deck-card-usage');root.dataset.deckCardUsage='';
    var scope=null,key='',serial=0,data=null,loadedAt=0,error='',loading=false,expanded=false,zone='monster',page=1,format='xlsx',exporting=false,status='';
    function words(){return TEXT[scope&&scope.lang]||TEXT.zh;}
    function render(){
      var active=document.activeElement,attribute=root.contains(active)?['data-card-expand','data-card-zone','data-card-prev','data-card-next','data-card-export','data-card-retry','data-export-format'].find(function(name){return active.hasAttribute(name);}):null;
      var value=attribute?active.getAttribute(attribute):null;
      draw();
      if(attribute){var replacement=Array.from(root.querySelectorAll('['+attribute+']')).find(function(node){return node.getAttribute(attribute)===value;});if(replacement&&!replacement.disabled)replacement.focus();}
    }
    function draw(){
      var t=words(),lang=scope&&scope.lang||'zh';root.replaceChildren();
      var heading=element('div',null,'deck-card-heading'),toggle=element('button',expanded?t.hide:t.show,'web-button');toggle.type='button';toggle.dataset.cardExpand='';
      toggle.setAttribute('aria-expanded',String(expanded));toggle.setAttribute('aria-controls','deckCardUsageBody');heading.append(element('h2',t.title),toggle);root.append(heading);
      toggle.onclick=function(){expanded=!expanded;render();if(expanded&&(!data||Date.now()-loadedAt>=30000)&&!loading&&!error)load();root.querySelector('[data-card-expand]').focus();};
      var body=element('div');body.id='deckCardUsageBody';body.hidden=!expanded;root.append(body);if(!expanded)return;
      body.append(element('p',t.hint,'muted'));
      if(loading){var progress=element('p',t.loading,'muted');progress.setAttribute('role','status');body.append(progress);return;}
      if(error){var failure=element('p',t[error]||t.failed,'muted'),retry=element('button',t.retry,'web-button');failure.setAttribute('role','status');retry.dataset.cardRetry='';retry.type='button';retry.onclick=load;body.append(failure,retry);return;}
      if(!data)return;
      var context=element('p',api.local(data.selected.names,lang)+' · '+(PERIODS[lang]||PERIODS.zh)[data.period]+(data.month?' '+data.month:'')+' · '+t.coverage.replace('%v%',data.coverage.validCardDecks).replace('%a%',data.coverage.allDecks),'muted');
      context.dataset.cardContext='';body.append(context);
      var toolbar=element('div',null,'web-controls deck-card-toolbar'),picker=api.formatPicker(format,function(value){format=value;});
      var download=element('button',t.download);download.type='button';download.dataset.cardExport='';
      download.disabled=exporting||!data.coverage.validCardDecks||!ZONES.some(function(name){return data.cards[name].length;});
      download.onclick=exportCards;
      var message=element('span',status,'csv-status muted');message.setAttribute('role','status');toolbar.append(picker,download,message);body.append(toolbar);
      if(!data.coverage.validCardDecks){var noSamples=element('p',t.noSamples,'empty-state');noSamples.dataset.cardNoSamples='';body.append(noSamples);return;}
      var tabs=element('div',null,'web-tabs deck-card-zones');
      ZONES.forEach(function(name,index){var tab=element('button',t.zones[index],zone===name?'active':'');tab.type='button';tab.dataset.cardZone=name;tab.setAttribute('aria-pressed',String(zone===name));tab.onclick=function(){zone=name;page=1;render();root.querySelector('[data-card-zone="'+name+'"]').focus();};tabs.append(tab);});body.append(tabs);
      var cards=data.cards[zone],pages=Math.max(1,Math.ceil(cards.length/50));page=Math.min(page,pages);
      if(!cards.length){var empty=element('p',t.empty,'empty-state');empty.dataset.cardEmpty='';body.append(empty);return;}
      var wrap=element('div',null,'table-wrap'),table=element('table'),thead=element('thead'),header=element('tr'),tbody=element('tbody');table.dataset.cardTable='';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label',t.zones[ZONES.indexOf(zone)]);
      ['rank','cardId','name','adoptionCount','adoptionRate','one','two','three'].forEach(function(name){var th=element('th',api.t(name,lang));th.scope='col';header.append(th);});thead.append(header);
      cards.slice((page-1)*50,page*50).forEach(function(card){var row=element('tr');[card.rank,card.cardId,card.name,card.deckCount,(Number(card.usageRate||0)*100).toFixed(2)+'%',card.copies1,card.copies2,card.copies3].forEach(function(value,index){var cell=element('td');if((index===1||index===2)&&Number.isSafeInteger(Number(card.cardId))&&Number(card.cardId)>0){var link=element('a',value,'inline-link');link.href='https://ygocdb.com/card/'+Number(card.cardId);link.target='_blank';link.rel='noopener';cell.append(link);}else cell.textContent=value;row.append(cell);});tbody.append(row);});
      table.append(thead,tbody);wrap.append(table);body.append(wrap);
      var pagination=element('div',null,'web-pagination deck-card-toolbar'),previous=element('button',t.prev),next=element('button',t.next);previous.type=next.type='button';previous.dataset.cardPrev='';next.dataset.cardNext='';previous.disabled=page<=1;next.disabled=page>=pages;
      previous.onclick=function(){page--;render();root.querySelector(page<=1?'[data-card-next]':'[data-card-prev]').focus();};next.onclick=function(){page++;render();root.querySelector(page>=pages?'[data-card-prev]':'[data-card-next]').focus();};pagination.append(previous,element('span',page+' / '+pages),next);body.append(pagination);
    }
    async function load(){
      if(!scope||loading)return;
      var requestScope=Object.assign({},scope),requestKey=key,requestSerial=++serial;
      loading=true;error='';status='';render();
      try{
        var query=new URLSearchParams({view:'card-usage',deckTypeId:String(requestScope.deckId),period:requestScope.period,month:requestScope.month||'',lang:requestScope.lang});
        var response=await fetch('/api/ladder/deck-detail?'+query.toString());
        if(!response.ok){var failed=Error('http');failed.status=response.status;throw failed;}
        var result=await response.json();
        if(!result||!result.available||!result.selected||Number(result.selected.id)!==Number(requestScope.deckId)||result.period!==requestScope.period||(requestScope.period==='month'&&result.month!==requestScope.month)||!result.coverage||!result.cards)throw Error('scope');
        if(requestSerial!==serial||requestKey!==key)return;
        ZONES.forEach(function(name){result.cards[name]=(Array.isArray(result.cards[name])?result.cards[name]:[]).slice(0,200);});data=result;loadedAt=Date.now();
      }catch(failed){if(requestSerial!==serial||requestKey!==key)return;error=({400:'invalid',404:'legacy',429:'busy',503:'timeout'})[failed.status]||'failed';}
      finally{if(requestSerial===serial&&requestKey===key){loading=false;render();}}
    }
    async function exportCards(){
      if(!data||exporting)return;
      // Capture one immutable response and language before asynchronous workbook loading.
      var snapshot=data,lang=scope.lang,exportKey=key,selectedFormat=format;exporting=true;status=api.t('preparing',lang);render();
      try{
        var suffix=snapshot.period==='month'?snapshot.month:snapshot.period;
        var filename='srvpro-deck-card-'+snapshot.selected.id+'-'+suffix+'-'+snapshot.coverage.validCardDecks+'-of-'+snapshot.coverage.allDecks+'.'+selectedFormat;
        var saved=selectedFormat==='csv'?await api.save(filename,api.deckCardRows(snapshot,lang)):await api.saveWorkbook(filename,'deck-card',snapshot,lang);
        if(exportKey===key)status=saved?api.t('saved',lang)+saved:'';
      }catch(failed){if(exportKey===key)status=api.t('failed',lang);}
      finally{exporting=false;render();}
    }
    function setScope(next,force){
      var nextKey=identity(next);scope=next;
      var changed=nextKey!==key;if(!changed&&!force)return;
      key=nextKey;serial++;data=null;loadedAt=0;error='';status='';loading=false;if(changed){zone='monster';page=1;}render();
      if(expanded&&scope)load();
    }
    render();return {setScope:setScope,mount:function(marker,next){setScope(next);marker.replaceWith(root);render();}};
  }
  global.SrvproDeckCardUsage={create:create};
})(window);
