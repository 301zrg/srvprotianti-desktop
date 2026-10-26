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
  global.SrvproCardImages = Object.freeze({mount:mount, sources:sources});
})(window);
