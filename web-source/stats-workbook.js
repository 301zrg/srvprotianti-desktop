(function (global) {
  'use strict';
  var LABELS = {
    zh:{tabs:['Match','单局','主牌局','备牌局'],groups:['综合','先攻','后攻'],usage:['怪兽','魔法','陷阱','额外','副卡组','卡组类型']},
    ja:{tabs:['マッチ','ゲーム','メイン','サイド'],groups:['総合','先攻','後攻'],usage:['モンスター','魔法','罠','EX','サイド','デッキタイプ']},
    en:{tabs:['Match','Game','Pre-side game','Post-side game'],groups:['Overall','Going first','Going second'],usage:['Monster','Spell','Trap','Extra','Side','Deck types']},
    ko:{tabs:['매치','단판','메인전','사이드전'],groups:['종합','선공','후공'],usage:['몬스터','마법','함정','엑스트라','사이드','덱 종류']}
  };
  function text(value) { return String(value == null ? '' : value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').slice(0,32767); }
  function color(rate, saturated) {
    var amount=Math.min(1,Math.abs(rate-.5)/(saturated ? .25 : .5)), end=rate<.5?[239,131,127]:[115,214,163];
    return 'FF'+[220,230,240].map(function(value,index){return Math.round(value+(end[index]-value)*amount).toString(16).padStart(2,'0');}).join('').toUpperCase();
  }
  function rate(cell,wins,total,saturated) {
    cell.value=total>0?wins/total:null;cell.numFmt='0.00%';
    cell.font={name:'Calibri',size:11,color:{argb:total>0?color(wins/total,saturated):'FFDCE6F0'}};
  }
  function share(cell,value) { cell.value=Number(value||0);cell.numFmt='0.0%'; }
  function init(workbook,name,title,period,month,widths,labels) {
    var sheet=workbook.addWorksheet(text(name).replace(/[\\/?*\[\]:]/g,' ').slice(0,31),{views:[{state:'frozen',xSplit:1,ySplit:4,showGridLines:false}]});
    sheet.columns=widths.map(function(width){return {width:width};});
    sheet.mergeCells(1,1,1,widths.length);sheet.getCell('A1').value=text(title);
    sheet.getCell('A2').value=labels('period');sheet.getCell('B2').value=text(period);
    sheet.getCell('C2').value=labels('month');sheet.getCell('D2').value=text(month);
    return sheet;
  }
  function style(sheet,columns) {
    sheet.eachRow(function(row,index){
      row.height=index===1?27:23;
      for(var n=1;n<=columns;n++){
        var cell=row.getCell(n);
        cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:index<=4?'FF243447':index%2?'FF1D2A38':'FF243447'}};
        if(!cell.font)cell.font={name:'Calibri',size:11,color:{argb:'FFDCE6F0'},bold:index<=4};
        cell.alignment={vertical:'middle',horizontal:n===1?'left':'center',wrapText:true};
      }
    });
    sheet.autoFilter={from:{row:4,column:1},to:{row:Math.max(4,sheet.rowCount),column:columns}};
  }
  function groupedHeader(sheet,leading,groups,t) {
    leading.forEach(function(label,index){sheet.mergeCells(3,index+1,4,index+1);sheet.getCell(3,index+1).value=label;});
    groups.forEach(function(label,index){
      var start=leading.length+1+index*3;sheet.mergeCells(3,start,3,start+2);sheet.getCell(3,start).value=text(label);
      ['rate','wins','samples'].forEach(function(key,n){sheet.getCell(4,start+n).value=t(key);});
    });
  }
  function appendValues(sheet,row,start,values,metrics,saturated) {
    metrics.forEach(function(metric,index){
      var total=Number(values&&values[metric[1]]||0),wins=Number(values&&values[metric[2]]||0),col=start+index*3;
      rate(sheet.getCell(row,col),wins,total,saturated);
      sheet.getCell(row,col+1).value=wins;sheet.getCell(row,col+2).value=total;
    });
  }
  function build(kind,data,lang) {
    var api=global.SrvproStatsExport,labels=LABELS[lang]||LABELS.zh,t=function(key){return api.t(key,lang);};
    var local=function(names){return text(api.local(names,lang));},workbook=new global.ExcelJS.Workbook();
    workbook.creator='706 Ladder Assistant';workbook.created=new Date();
    if(kind==='matrix'){
      if(!data||!data.decks||!data.decks.length)throw Error('empty');
      api.metrics.forEach(function(metric,index){
        var opponents=data.decks.map(function(deck){return {id:deck.id,name:local(deck.name)};}).concat([{id:'all',name:t('all')}]);
        var count=1+opponents.length*3,sheet=init(workbook,t('metrics')[index],t('metrics')[index],'month',data.monthKey,[30].concat(Array(count-1).fill(15)),t);
        groupedHeader(sheet,[t('deck')],opponents.map(function(item){return item.name;}),t);
        data.decks.forEach(function(deck,row){sheet.getCell(row+5,1).value=local(deck.name);opponents.forEach(function(opponent,col){
          appendValues(sheet,row+5,2+col*3,(data.stats||{})[deck.id+'::'+opponent.id],[metric],true);
        });});style(sheet,count);
      });
    }else if(kind==='detail'||kind==='player'){
      if(!data||!data.overall)throw Error('empty');
      labels.tabs.forEach(function(tab,index){
        var player=kind==='player',count=player?11:10;
        var sheet=init(workbook,tab,(player?t('allDecks'):local(data.selected.names))+' · '+tab,data.scope||data.period,data.month,[30].concat(Array(count-1).fill(16)),t);
        groupedHeader(sheet,player?[t('deck'),t('opponent')]:[t('opponent')],labels.groups,t);
        if(!player){sheet.getCell('E2').value=t('count');sheet.getCell('F2').value=Number(data.usage&&data.usage.count||0);sheet.getCell('G2').value=t('usageRate');rate(sheet.getCell('H2'),Number(data.usage&&data.usage.usageRate||0),1,false);}
        var row=5,metrics=api.metrics.slice(index*3,index*3+3);
        function block(deck,name){
          [{names:null,values:deck.overall}].concat(deck.opponents||[]).forEach(function(opponent){
            sheet.getCell(row,1).value=player?name:opponent.names?local(opponent.names):t('all');
            if(player)sheet.getCell(row,2).value=opponent.names?local(opponent.names):t('all');
            appendValues(sheet,row,player?3:2,opponent.values,metrics,!player);row++;
          });
        }
        block(data,t('allDecks'));if(player)(data.decks||[]).forEach(function(deck){block(deck,local(deck.names));});
        if(player)sheet.views=[{state:'frozen',xSplit:2,ySplit:4,showGridLines:false}];style(sheet,count);
      });
    }else if(kind==='deck-card'){
      if(!data||!data.selected||!data.coverage||!data.coverage.validCardDecks)throw Error('empty');
      ['monster','spell','trap','extra','side'].forEach(function(zone,index){
        var keys=['rank','cardId','name','adoptionCount','denominator','adoptionRate','one','oneShare','two','twoShare','three','threeShare'];
        var sheet=init(workbook,labels.usage[index],local(data.selected.names)+' · '+labels.usage[index],data.period,data.month,keys.map(function(key){return key==='name'?34:16;}),t);
        sheet.getCell('E2').value=t('validSamples');sheet.getCell('F2').value=data.coverage.validCardDecks;
        sheet.getCell('G2').value=t('allSamples');sheet.getCell('H2').value=data.coverage.allDecks;
        [t('startDay'),text(data.startDay),t('endDay'),text(data.endDay),t('deckId'),data.selected.id].forEach(function(value,col){sheet.getCell(3,col+1).value=value;});
        keys.forEach(function(key,col){sheet.getCell(4,col+1).value=t(key);});
        (data.cards&&data.cards[zone]||[]).slice(0,200).forEach(function(item,row){
          [item.rank,item.cardId,text(item.name),item.deckCount,data.coverage.validCardDecks,null,item.copies1,null,item.copies2,null,item.copies3,null].forEach(function(value,col){sheet.getCell(row+5,col+1).value=value;});
          rate(sheet.getCell(row+5,6),Number(item.deckCount||0),Number(data.coverage.validCardDecks||0),false);
          [1,2,3].forEach(function(n){share(sheet.getCell(row+5,6+n*2),api.copyShare(item,n));});
        });style(sheet,keys.length);
      });
    }else if(kind==='usage'){
      var rows=data&&data.rows;if(!rows||rows.length<2)throw Error('empty');
      ['monster','spell','trap','extra','side','deck'].forEach(function(metric,index){
        var deck=metric==='deck',keys=deck?['rank','name','count','denominator','usageRate']:['rank','cardId','name','count','denominator','usageRate','one','oneShare','two','twoShare','three','threeShare'];
        var sheet=init(workbook,labels.usage[index],labels.usage[index],rows[1][0],rows[1][1],keys.map(function(key){return key==='name'?32:16;}),t);
        keys.forEach(function(key,col){sheet.getCell(4,col+1).value=t(key);});
        rows.slice(1).filter(function(row){return row[2]===metric;}).forEach(function(item,index){
          // usageRows: counts at 9/11/13, shares (already rendered as text) at 10/12/14.
          var values=deck?[item[3],text(item[5]),item[6],item[7],null]:[item[3],item[4],text(item[5]),item[6],item[7],null,item[9],null,item[11],null,item[13],null];
          values.forEach(function(value,col){sheet.getCell(index+5,col+1).value=value==null?null:value;});
          rate(sheet.getCell(index+5,deck?5:6),Number(item[6]||0),Number(item[7]||0),false);
          if(!deck)[1,2,3].forEach(function(n){share(sheet.getCell(index+5,6+n*2),Number(item[6])>0?Number(item[7+n*2]||0)/Number(item[6]):0);});
        });style(sheet,keys.length);
      });
    }else if(kind==='split'){
      if(!data||!data.card||!data.decks||!data.decks.length)throw Error('empty');
      var splitKeys=['rank','deckName','deckTypeId','share','deckUses','deckValid','inDeck'];
      var split=init(workbook,text(data.card.name),text(data.card.name)+' ('+data.card.cardId+')',data.period,data.month,splitKeys.map(function(key){return key==='deckName'?34:16;}),t);
      split.getCell('E2').value=t('count');split.getCell('F2').value=data.deckCount;split.getCell('G2').value=t('usageRate');rate(split.getCell('H2'),Number(data.usageRate||0),1,false);
      split.getCell('A3').value=t('cardId2');split.getCell('B3').value=data.card.cardId;split.getCell('C3').value=t('metric');split.getCell('D3').value=text(data.card.zone);
      splitKeys.forEach(function(key,col){split.getCell(4,col+1).value=t(key);});
      data.decks.forEach(function(deck,row){
        [deck.rank,local(deck.names),deck.deckTypeId,null,deck.deckCount,deck.validDecks,null].forEach(function(value,col){split.getCell(row+5,col+1).value=value;});
        share(split.getCell(row+5,4),deck.share);rate(split.getCell(row+5,7),Number(deck.adoptionRate||0),1,false);
      });style(split,splitKeys.length);
    }else throw Error('unknown workbook');
    return workbook;
  }
  global.SrvproWorkbook={build:build,bytes:async function(kind,data,lang){
    var workbook=build(kind,data,lang);return new Uint8Array(await workbook.xlsx.writeBuffer());
  }};
})(window);
