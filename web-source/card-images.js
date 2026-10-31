(function(global) {
  'use strict';
  var active = 0, queue = [], localCache = new Map(), cacheSize = 0;
  var CACHE_LIMIT = 8 * 1024 * 1024;

  function sources(cardId, language) {
    var id = Number(cardId);
    if (!Number.isInteger(id) || id <= 0 || id > 4294967295) return [];
    var locale = {zh:'sc', ja:'jp', en:'en', ko:'jp'}[language] || 'sc';
    return (locale === 'en' ? ['en'] : [locale, 'en']).map(function(code) {
      return 'https://cdn.233.momobako.com/ygoimg/' + code + '/' + id + '.webp!half';
    });
  }

  function remember(id, source) {
    if (localCache.has(id)) cacheSize -= localCache.get(id).length;
    localCache.delete(id);
    if (source.length > CACHE_LIMIT) return;
    localCache.set(id, source);
    cacheSize += source.length;
    while (cacheSize > CACHE_LIMIT || localCache.size > 32) {
      var oldest = localCache.keys().next().value;
      cacheSize -= localCache.get(oldest).length;
      localCache.delete(oldest);
    }
  }

  function pump() {
    while (active < 4 && queue.length) {
      active++;
      Promise.resolve().then(queue.shift()).catch(function() {}).finally(function() {
        active--;
        pump();
      });
    }
  }

  function mount(anchor, options) {
    var disposed = false, started = false, observer, cancelCurrent = function() {};
    var fallback = anchor.querySelector('.card-image-fallback');
    var urls = sources(options.cardId, options.language), id = Number(options.cardId);
    anchor.dataset.imageState = 'waiting';

    function probe(source) {
      return new Promise(function(resolve) {
        var image = new Image(), finished = false;
        image.alt = '';
        image.hidden = true;
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';
        function done(ok) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          image.onload = image.onerror = null;
          cancelCurrent = function() {};
          if (!ok || disposed) {
            image.removeAttribute('src');
            image.remove();
            resolve(null);
          } else resolve(image);
        }
        var timer = setTimeout(function() { done(false); }, 8000);
        cancelCurrent = function() { done(false); };
        image.onload = function() { done(image.naturalWidth > 0); };
        image.onerror = function() { done(false); };
        anchor.appendChild(image);
        image.src = source;
      });
    }

    function readLocal() {
      // An IPC read cannot be cancelled; keep its queue slot until it really ends.
      return Promise.resolve().then(function() {
        return global.SrvproDesktop.cardImages(id);
      }).catch(function() { return []; });
    }

    async function load() {
      if (disposed || !urls.length) return;
      anchor.dataset.imageState = 'loading';
      var image = null, cached = localCache.get(id);
      if (cached) image = await probe(cached);
      if (!image && !disposed && global.SrvproDesktop && typeof global.SrvproDesktop.cardImages === 'function') {
        var candidates = await readLocal();
        if (Array.isArray(candidates)) for (var i = 0; i < candidates.length && !disposed; i++) {
          var item = candidates[i];
          if (!item || typeof item.bodyBase64 !== 'string' || !/^image\/(jpeg|png|webp)$/.test(item.contentType)) continue;
          var source = 'data:' + item.contentType + ';base64,' + item.bodyBase64;
          image = await probe(source);
          if (image) { remember(id, source); break; }
        }
      }
      for (var j = 0; !image && !disposed && j < urls.length; j++) image = await probe(urls[j]);
      if (disposed) return;
      anchor.dataset.imageState = image ? 'loaded' : 'failed';
      if (image) { image.hidden = false; if (fallback) fallback.hidden = true; }
    }

    function start() {
      if (started || disposed) return;
      started = true;
      if (observer) observer.disconnect();
      queue.push(load);
      pump();
    }
    if ('IntersectionObserver' in global) {
      observer = new IntersectionObserver(function(entries) {
        if (entries.some(function(entry) { return entry.isIntersecting; })) start();
      }, {rootMargin:'160px'});
      observer.observe(anchor);
    } else start();
    return function() {
      disposed = true;
      if (observer) observer.disconnect();
      queue = queue.filter(function(job) { return job !== load; });
      cancelCurrent();
      anchor.querySelectorAll('img').forEach(function(image) { image.removeAttribute('src'); image.remove(); });
    };
  }
  function readView() {
    try { return localStorage.getItem('srvpro.usage.view.v1') === 'image' ? 'image' : 'list'; }
    catch (_) { return 'list'; }
  }

  function saveView(view) {
    try { localStorage.setItem('srvpro.usage.view.v1', view === 'image' ? 'image' : 'list'); }
    catch (_) {}
  }

  function element(tag, text, className) {
    var node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function renderGrid(grid, cards, options) {
    var labels = options.labels, disposers = [];
    grid.replaceChildren();
    cards.forEach(function(card) {
      var article = element('article', null, 'usage-card');
      var heading = element('div', null, 'usage-card-heading'), rate = element('span', null, 'usage-rate');
      rate.append(element('small', labels.rate), element('strong', (Number(card.usageRate || 0) * 100).toFixed(2) + '%'));
      heading.append(element('span', labels.rank + ' ' + card.rank, 'usage-rank'), rate);
      var link = element('a', null, 'card-image-link'), id = Number(card.cardId);
      if (Number.isInteger(id) && id > 0 && id <= 4294967295) link.href = 'https://ygocdb.com/card/' + id;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = String(card.name || '') + ' (' + card.cardId + ')';
      link.setAttribute('aria-label', link.title);
      var fallback = element('span', null, 'card-image-fallback');
      fallback.append(element('strong', card.name), element('span', card.cardId));
      link.append(fallback);
      var counts = element('dl', null, 'usage-card-counts'), total = Number(card.deckCount || 0);
      var bar = element('div', null, 'usage-copy-bar');
      bar.setAttribute('aria-hidden', 'true');
      [['decks', 'deckCount'], ['one', 'copies1'], ['two', 'copies2'], ['three', 'copies3']].forEach(function(pair, index) {
        var item = element('div', null, index === 0 ? 'usage-card-decks' : 'usage-copy-' + index);
        var value = element('dd');
        value.append(element('span', card[pair[1]], 'usage-copy-count'));
        if (index) {
          // Share of the decks playing this card that run exactly this many copies.
          var share = total > 0 ? Number(card[pair[1]] || 0) / total : 0;
          value.append(element('small', (share * 100).toFixed(1) + '%', 'usage-copy-share'));
          var segment = element('span', null, 'usage-copy-' + index);
          segment.style.width = (share * 100).toFixed(2) + '%';
          bar.append(segment);
        }
        item.append(element('dt', labels[pair[0]]), value);
        counts.append(item);
      });
      article.append(heading, link, counts, bar);
      grid.append(article);
      disposers.push(mount(link, {cardId:id, language:options.language}));
    });
    return function() { disposers.forEach(function(dispose) { dispose(); }); };
  }

  global.SrvproCardImages = Object.freeze({mount:mount, sources:sources, readView:readView, saveView:saveView, renderGrid:renderGrid});
})(window);
