(function (global) {
  'use strict';
  var METRICS = [
    ['matchOverall','matches','matchWins'], ['matchFirst','firstMatches','firstWins'], ['matchSecond','secondMatches','secondWins'],
    ['gameOverall','games','gameWins'], ['gameFirst','firstGames','firstGameWins'], ['gameSecond','secondGames','secondGameWins'],
    ['mainOverall','mainGames','mainGameWins'], ['mainFirst','mainFirstGames','mainFirstGameWins'], ['mainSecond','mainSecondGames','mainSecondGameWins'],
    ['sideOverall','sideGames','sideGameWins'], ['sideFirst','sideFirstGames','sideFirstGameWins'], ['sideSecond','sideSecondGames','sideSecondGameWins']
  ];
  var TEXT = {
    zh: {matrix:'下载所选月全部指标（CSV）',usage:'下载所选时期全部使用率（CSV）',detail:'下载所选时期胜率统计',
      zone:'区域',deckId:'卡组类型ID',allSamples:'全部样本',validSamples:'有效卡片样本',startDay:'开始日',endDay:'结束日（不含）',adoptionCount:'采用卡组数',adoptionRate:'采用率',
      preparing:'正在准备表格…',empty:'暂无可导出的数据。',failed:'导出失败，请重试。',saved:'表格已保存：',
      limit:'卡片使用率每类最多导出前200名；卡组使用率导出全部类型。',all:'总计',allDecks:'全部卡组',
      period:'时期',month:'月份',metric:'指标',deck:'使用卡组',opponent:'对手卡组',wins:'胜场数',samples:'样本数',rate:'胜率',
      rank:'排名',cardId:'卡片密码',name:'名称',count:'使用数',denominator:'统计分母',usageRate:'使用率',one:'投入1张',two:'投入2张',three:'投入3张',
      metrics:['Match综合','Match先攻','Match后攻','单局综合','单局先攻','单局后攻','主牌局综合','主牌局先攻','主牌局后攻','备牌局综合','备牌局先攻','备牌局后攻']},
    ja: {matrix:'選択月の全指標を保存（CSV）',usage:'選択期間の全使用率を保存（CSV）',detail:'選択期間の勝率統計を保存',
      zone:'区分',deckId:'デッキタイプID',allSamples:'全標本',validSamples:'有効カード標本',startDay:'開始日',endDay:'終了日（含まない）',adoptionCount:'採用デッキ数',adoptionRate:'採用率',
      preparing:'表を準備中…',empty:'保存できるデータがありません。',failed:'保存に失敗しました。再試行してください。',saved:'表を保存しました：',
      limit:'カードは各区分の上位200件まで、デッキタイプは全件を保存します。',all:'合計',allDecks:'全デッキ',
      period:'期間',month:'月',metric:'指標',deck:'使用デッキ',opponent:'対戦デッキ',wins:'勝利数',samples:'標本数',rate:'勝率',
      rank:'順位',cardId:'カードID',name:'名前',count:'使用数',denominator:'分母',usageRate:'使用率',one:'1枚採用',two:'2枚採用',three:'3枚採用',
      metrics:['マッチ総合','マッチ先攻','マッチ後攻','ゲーム総合','ゲーム先攻','ゲーム後攻','メイン総合','メイン先攻','メイン後攻','サイド総合','サイド先攻','サイド後攻']},
    en: {matrix:'Download selected month: all metrics (CSV)',usage:'Download selected period: all usage (CSV)',detail:'Download selected period win-rate statistics',
      zone:'Zone',deckId:'Deck type ID',allSamples:'All samples',validSamples:'Valid card samples',startDay:'Start day',endDay:'End day (exclusive)',adoptionCount:'Decks using card',adoptionRate:'Adoption rate',
      preparing:'Preparing table…',empty:'No data to export.',failed:'Export failed. Please retry.',saved:'Table saved: ',
      limit:'Exports up to the top 200 cards per category and all deck types.',all:'Overall',allDecks:'All decks',
      period:'Period',month:'Month',metric:'Metric',deck:'Player deck',opponent:'Opponent deck',wins:'Wins',samples:'Samples',rate:'Win rate',
      rank:'Rank',cardId:'Card ID',name:'Name',count:'Uses',denominator:'Denominator',usageRate:'Usage rate',one:'At 1',two:'At 2',three:'At 3',
      metrics:['Match overall','Match first','Match second','Game overall','Game first','Game second','Main overall','Main first','Main second','Side overall','Side first','Side second']},
    ko: {matrix:'선택 월 전체 지표 저장(CSV)',usage:'선택 기간 전체 사용률 저장(CSV)',detail:'선택 기간 승률 통계 저장',
      zone:'구역',deckId:'덱 종류 ID',allSamples:'전체 표본',validSamples:'유효 카드 표본',startDay:'시작일',endDay:'종료일(제외)',adoptionCount:'채택 덱 수',adoptionRate:'채택률',
      preparing:'표 준비 중…',empty:'내보낼 데이터가 없습니다.',failed:'내보내기에 실패했습니다. 다시 시도하세요.',saved:'표 저장됨: ',
      limit:'카드는 분류별 상위 200개까지, 덱 종류는 전체를 저장합니다.',all:'전체',allDecks:'모든 덱',
      period:'기간',month:'월',metric:'지표',deck:'사용 덱',opponent:'상대 덱',wins:'승수',samples:'표본 수',rate:'승률',
      rank:'순위',cardId:'카드 ID',name:'이름',count:'사용 수',denominator:'집계 분모',usageRate:'사용률',one:'1장 투입',two:'2장 투입',three:'3장 투입',
      metrics:['매치 종합','매치 선공','매치 후공','단판 종합','단판 선공','단판 후공','메인 종합','메인 선공','메인 후공','사이드 종합','사이드 선공','사이드 후공']}
  };
  function language() { return global.SrvproWeb.getLanguage(); }
  var FORMAT={zh:'导出格式',ja:'保存形式',en:'Export format',ko:'내보내기 형식'};
  var workbookLoading=null;
  function t(key, lang) { return (TEXT[lang || language()] || TEXT.zh)[key]; }
  function local(names, lang) { return names && (names[lang || language()] || names.zh) || '—'; }
  function percent(value) { return (Number(value || 0) * 100).toFixed(4) + '%'; }
  function cell(value) {
    var text = value == null ? '' : String(value);
    // Names are text, never spreadsheet formulas; numeric counters stay numeric.
    if (typeof value === 'string' && /^[\s\uFEFF]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function csv(rows) { return '\uFEFF' + rows.map(function (row) { return row.map(cell).join(','); }).join('\r\n') + '\r\n'; }
  async function save(filename, rows) {
    var contents = csv(rows);
    if (global.SrvproDesktop && typeof global.SrvproDesktop.saveCsv === 'function') {
      return global.SrvproDesktop.saveCsv(filename, contents);
    }
    var url = URL.createObjectURL(new Blob([contents], {type:'text/csv;charset=utf-8'}));
    var anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    return null;
  }
  function formatPicker(value,onChange) {
    var label=document.createElement('label'),caption=document.createElement('span'),select=document.createElement('select');
    select.dataset.exportFormat='';
    [['xlsx','Excel (.xlsx)'],['csv','CSV (.csv)']].forEach(function(item){var option=document.createElement('option');option.value=item[0];option.textContent=item[1];select.appendChild(option);});
    select.value=value;select.onchange=function(){onChange(select.value);};
    label.append(caption,document.createTextNode(' '),select);
    label.updateLabels=function(){caption.textContent=FORMAT[language()]||FORMAT.zh;select.setAttribute('aria-label',caption.textContent);};
    label.updateLabels();return label;
  }
  function script(url,ready) {
    if(ready())return Promise.resolve();
    return new Promise(function(resolve,reject){
      var node=document.createElement('script');node.src=url;node.onload=function(){if(ready())resolve();else{node.remove();reject(Error('workbook'));}};
      node.onerror=function(){node.remove();reject(Error('workbook'));};document.head.appendChild(node);
    });
  }
  async function saveWorkbook(filename,kind,data,lang) {
    if(!workbookLoading)workbookLoading=Promise.all([
      script('/assets/exceljs-4.4.0.min.js',function(){return !!global.ExcelJS;}),
      script('/assets/stats-workbook.js?v=20261025-deck-card',function(){return !!global.SrvproWorkbook;})
    ]).catch(function(error){workbookLoading=null;throw error;});
    await workbookLoading;
    var bytes=await global.SrvproWorkbook.bytes(kind,data,lang);
    if(global.SrvproDesktop&&typeof global.SrvproDesktop.saveXlsx==='function')return global.SrvproDesktop.saveXlsx(filename,bytes);
    var url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
    var anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();
    setTimeout(function(){URL.revokeObjectURL(url);},30000);return null;
  }
  function statHeader(lang, extra) {
    return (extra || ['period','month','deck','opponent','metric','wins','samples','rate']).map(function (key) { return t(key, lang); });
  }
  function appendStats(rows, prefix, values, lang) {
    METRICS.forEach(function (metric, index) {
      var total = Number(values && values[metric[1]] || 0), wins = Number(values && values[metric[2]] || 0);
      rows.push(prefix.concat([t('metrics',lang)[index], wins, total, total ? percent(wins / total) : '']));
    });
  }
  function matrixRows(data, lang) {
    if (!data || !data.decks || !data.decks.length) return [];
    var rows = [statHeader(lang)];
    data.decks.forEach(function (deck) {
      data.decks.forEach(function (opponent) {
        appendStats(rows, ['month', data.monthKey, local(deck.name,lang), local(opponent.name,lang)], (data.stats || {})[deck.id+'::'+opponent.id], lang);
      });
      appendStats(rows, ['month', data.monthKey, local(deck.name,lang), t('all',lang)], (data.stats || {})[deck.id+'::all'], lang);
    });
    return rows;
  }
  function detailRows(data, lang) {
    if (!data || !data.selected) return [];
    var rows = [statHeader(lang, ['period','month','deck','opponent','metric','wins','samples','rate','count','usageRate'])];
    var entries = [{names:null, values:data.overall}].concat(data.opponents || []);
    entries.forEach(function (entry) {
      var before = rows.length;
      appendStats(rows, [data.period, data.month || '', local(data.selected.names,lang), entry.names ? local(entry.names,lang) : t('all',lang)], entry.values, lang);
      for (var i=before;i<rows.length;i++) rows[i].push(Number(data.usage && data.usage.count || 0), percent(data.usage && data.usage.usageRate));
    });
    return rows;
  }
  var CARD_ZONES=['monster','spell','trap','extra','side'];
  function deckCardRows(data,lang) {
    if(!data||!data.selected||!data.coverage||!data.coverage.validCardDecks)return [];
    var rows=[statHeader(lang,['period','month','deck','deckId','startDay','endDay','allSamples','validSamples','zone','rank','cardId','name','adoptionCount','denominator','adoptionRate','one','two','three'])];
    CARD_ZONES.forEach(function(zone){(data.cards&&data.cards[zone]||[]).slice(0,200).forEach(function(item){
      rows.push([data.period,data.month||'',local(data.selected.names,lang),data.selected.id,data.startDay||'',data.endDay||'',
        data.coverage.allDecks,data.coverage.validCardDecks,zone,item.rank,item.cardId,item.name,item.deckCount,
        data.coverage.validCardDecks,percent(item.usageRate),item.copies1,item.copies2,item.copies3]);
    });});
    return rows.length>1?rows:[];
  }
  async function fetchJson(url) {
    var response = await fetch(url);
    if (!response.ok) throw Error('export');
    var data = await response.json();
    if (!data || data.error) throw Error('export');
    return data;
  }
  async function usageRows(state, lang) {
    var rows = [statHeader(lang,['period','month','metric','rank','cardId','name','count','denominator','usageRate','one','two','three'])];
    var metrics = ['monster','spell','trap','extra','side','deck'];
    var day = null;
    // One request at a time: exporting six categories must not create a burst
    // of simultaneous aggregate queries on the game server.
    for (var metric of metrics) {
      var page = 1, pages = 1;
      do {
        var endpoint = metric === 'deck' ? '/api/ladder/usage/decks' : '/api/ladder/usage/cards';
        var query = new URLSearchParams({metric:metric,period:state.period,month:state.month,page:String(page),lang:lang});
        var data = await fetchJson(endpoint + '?' + query.toString());
        var identity = JSON.stringify([data.period,data.month,data.startDay,data.endDay]);
        if (day !== null && identity !== day) throw Error('period changed');
        day = identity;
        if (data.period !== state.period || (state.period === 'month' && data.month !== state.month)) throw Error('period changed');
        var coverage = data.coverage || {};
        (metric === 'deck' ? data.decks || [] : data.cards || []).forEach(function (item) {
          rows.push([data.period,data.month || '',metric,item.rank,metric === 'deck' ? '' : item.cardId,
            metric === 'deck' ? local(item.names,lang) : item.name,metric === 'deck' ? item.count : item.deckCount,
            metric === 'deck' ? coverage.allDecks : coverage.validCardDecks,percent(item.usageRate),
            metric === 'deck' ? '' : item.copies1,metric === 'deck' ? '' : item.copies2,metric === 'deck' ? '' : item.copies3]);
        });
        pages = metric === 'deck' ? 1 : Math.max(1,Math.ceil(Number(data.total || 0) / Number(data.pageSize || 50)));
        if (pages > 200) throw Error('page limit');
        page++;
      } while (page <= pages);
    }
    return rows.length > 1 ? rows : [];
  }
  function playerRows(data, lang) {
    var rows = [statHeader(lang)];
    function append(deck, label) {
      appendStats(rows,[data.scope,data.month || '',label,t('all',lang)],deck.overall,lang);
      (deck.opponents || []).forEach(function (opponent) {
        appendStats(rows,[data.scope,data.month || '',label,local(opponent.names,lang)],opponent.values,lang);
      });
    }
    append(data,t('allDecks',lang));
    (data.decks || []).forEach(function (deck) { append(deck,local(deck.names,lang)); });
    return rows;
  }
  function mount(kind, getState) {
    var host = document.querySelector(kind === 'matrix' ? '.controls' : '.web-controls');
    if (!host) return;
    var button = document.createElement('button'), status = document.createElement('span');
    button.type = 'button'; button.className = 'csv-download'; button.dataset.csvExport = kind;
    status.className = 'csv-status muted'; status.setAttribute('role','status');
    var format='xlsx',picker=formatPicker(format,function(value){format=value;labels();});
    host.append(picker,button,status);
    var hint;
    if (kind === 'usage') { hint=document.createElement('p'); hint.className='muted'; host.after(hint); }
    function labels() { button.textContent=t(kind).replace('CSV',format==='csv'?'CSV':'XLSX'); picker.updateLabels();if(hint)hint.textContent=t('limit'); }
    labels(); document.addEventListener('srvpro-language-change', labels);
    button.addEventListener('click', async function () {
      var state = getState(), lang = language(),selectedFormat=format;
      button.disabled=true; status.textContent=t('preparing',lang);
      try {
        var rows,data;
        if (kind === 'usage') {rows=await usageRows({period:state.period,month:state.month},lang);data={rows:rows};}
        else {
          data=state.data;
          if (kind==='matrix' && data && data.monthKey!==state.month) data=await fetchJson('/api/ladder-deck-stats?month='+encodeURIComponent(state.month));
          if (kind==='detail' && data && state.deckId && Number(data.selected && data.selected.id)!==Number(state.deckId)) data=null;
          rows=selectedFormat==='csv'?(kind==='matrix'?matrixRows(data,lang):detailRows(data,lang)):
            data&&(kind==='matrix'?data.decks&&data.decks.length:data.selected)?[true]:[];
        }
        if (!rows.length) {status.textContent=t('empty',lang);return;}
        var period=kind==='matrix'?'month':state.period;
        var suffix=period==='month'?state.month:period;
        var file='srvpro-'+kind+'-'+(kind==='detail'&&data&&data.selected?data.selected.id+'-':'')+suffix+'.'+selectedFormat;
        var saved=selectedFormat==='csv'?await save(file,rows):await saveWorkbook(file,kind,data,lang); status.textContent=saved?t('saved',lang)+saved:'';
      } catch(error) { status.textContent=t('failed',lang); }
      finally {button.disabled=false;}
    });
  }
  global.SrvproStatsExport={metrics:METRICS,t:t,local:local,percent:percent,csv:csv,save:save,appendStats:appendStats,
    matrixRows:matrixRows,detailRows:detailRows,deckCardRows:deckCardRows,usageRows:usageRows,playerRows:playerRows,mount:mount,formatPicker:formatPicker,saveWorkbook:saveWorkbook};
})(window);
