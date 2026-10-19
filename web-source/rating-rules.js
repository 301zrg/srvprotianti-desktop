(function (global) {
  'use strict';
  var rules = null;
  var TEXT = {
    zh:{dynamic:'当前计分：综合分＝总等级分×{total}%＋当月等级分×{month}%；按双方综合分差采用 Elo 计分（K＝{k}），每场 Match 胜者加{min}～{max}分、败者减{min}～{max}分，总分与当月分同时更新，积分最低为{floor}分；新账号及每月初始分为{initial}分。',fixed:'当前采用固定计分：每场 Match 胜者增加{fixed}分、败者扣除{fixed}分，总分与当月分同时更新，积分最低为{floor}分；新账号及每月初始分为{initial}分。'},
    ja:{dynamic:'現在の計算：総合レート＝通算×{total}%＋当月×{month}%。双方の差に基づくElo方式（K＝{k}）で、1マッチにつき勝者は{min}～{max}増加、敗者は{min}～{max}減少します。通算・当月に同じ変動を反映し、下限は{floor}です。新規・各月の初期値は{initial}です。',fixed:'現在は固定方式：1マッチにつき勝者は{fixed}増加、敗者は{fixed}減少します。通算・当月に同じ変動を反映し、下限は{floor}です。新規・各月の初期値は{initial}です。'},
    en:{dynamic:'Current scoring: combined rating = all-time rating × {total}% + current-month rating × {month}%. Elo uses the two combined ratings (K = {k}); each Match awards the winner {min}–{max} points and deducts {min}–{max} from the loser. Both ratings receive the same change, with a floor of {floor}. New accounts and each month start at {initial}.',fixed:'Current fixed scoring: each Match awards the winner {fixed} points and deducts {fixed} from the loser. Both all-time and monthly ratings receive the same change, with a floor of {floor}. New accounts and each month start at {initial}.'},
    ko:{dynamic:'현재 계산: 종합 점수＝전체 점수×{total}%＋당월 점수×{month}%. 두 종합 점수 차이에 따라 Elo(K＝{k})로 계산하며 매치마다 승자는 {min}～{max}점 증가, 패자는 {min}～{max}점 감소합니다. 전체와 당월 점수에 같은 변동을 반영하며 최저 {floor}점입니다. 새 계정 및 매월 초기 점수는 {initial}점입니다.',fixed:'현재 고정 계산: 매치마다 승자는 {fixed}점 증가, 패자는 {fixed}점 감소합니다. 전체와 당월 점수에 같은 변동을 반영하며 최저 {floor}점입니다. 새 계정 및 매월 초기 점수는 {initial}점입니다.'}
  };
  function valid(value) {
    return value && typeof value.useDynamic==='boolean' && ['initialPoints','totalWeight','monthWeight','kFactor','minDelta','maxDelta','fixedDelta','minimumPoints']
      .every(function(key){return Number.isFinite(value[key]);});
  }
  function render() {
    document.querySelectorAll('[data-rating-rules]').forEach(function(root){
      root.hidden=!valid(rules);
      if(root.hidden){root.textContent='';return;}
      var values={total:Number((rules.totalWeight*100).toFixed(2)),month:Number((rules.monthWeight*100).toFixed(2)),
        initial:rules.initialPoints,k:rules.kFactor,min:rules.minDelta,max:rules.maxDelta,fixed:rules.fixedDelta,floor:rules.minimumPoints};
      var text=(TEXT[global.SrvproWeb.getLanguage()]||TEXT.zh)[rules.useDynamic?'dynamic':'fixed'];
      root.textContent=text.replace(/\{(\w+)\}/g,function(_,key){return values[key];});
    });
  }
  document.addEventListener('srvpro-language-change',render);
  global.SrvproRatingRules={update:function(value){rules=valid(value)?value:null;render();}};
  fetch('/api/ladder-config').then(function(response){if(!response.ok)throw Error();return response.json();})
    .then(function(data){global.SrvproRatingRules.update(data.rating);}).catch(function(){render();});
})(window);
