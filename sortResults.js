// Sorts product results by discount (best first) in the site's own data, before the site renders it - so the cards are in
// discount order in the page itself, and screen readers and keyboard focus follow the same order as what's shown.
// Sorting is within the results the site loaded (one page of them); which products are on which page is still the site's
// choice (its own sort option and filters) - unless they've been sorted across all pages by "Sort All Pages by Discount"
// (sortAllPages.js), see below.
// Runs in the page's main world at document_start, before any of the site's scripts:
// - the first page of results comes in the HTML as window.__PRELOADED_STATE__: its search.products lists (promotions,
//   searchResults, category, ...) are product ids in display order, with each product in search.productCardDictionary.
//   Caught as the page sets it, and those lists are sorted before the site reads them.
// - later results (next page, filters, sorting, ...) come from the products API: the items of those responses are sorted
//   before the site reads them.
// If the site's data ever looks different, nothing is sorted - the page is left as the site made it.
(() => {
  // the product list requests seen so far: /promotions/products, /search, /categories/<id>/search
  const PRODUCT_REQUEST = /^https:\/\/storefrontgateway\.shoprite\.com\/api\/.*\/(products|search)\?/;

  // best discount first (discount.js, loaded just before this file)
  const { sortByDiscount } = __salePriceDiscount;

  // 1. the first page, from the HTML
  if (!('__PRELOADED_STATE__' in window)) {
    let preloadedState;
    Object.defineProperty(window, '__PRELOADED_STATE__', {
      configurable: true,
      enumerable: true,
      get: () => preloadedState,
      set(state) {
        try {
          const dictionary = state?.search?.productCardDictionary;
          for (const list of Object.values(state?.search?.products ?? {})) {
            if (dictionary && Array.isArray(list) && list.every(id => dictionary[id])) sortByDiscount(list, id => dictionary[id]);
          }
        } catch (error) {
          console.warn('[Sort by discount] Could not sort the first page of results:', error);
        }
        preloadedState = state;
      }
    });
  }

  // A result set sorted across all of its pages, by sortAllPages.js ("Sort All Pages by Discount"): the site's page
  // requests for it get their slice of that list (by the request's own skip/take) instead of the server's page - so page 1
  // has the best deals of all the results, and the site's own pagination, filters and sidebar keep working. A result set
  // is a request minus its paging (skip/take/page); a different one (another filter, sort, search) is sorted per page as
  // usual. Kept in memory until the page is reloaded.
  let allPages = null;
  const resultSetKey = href => {
    const url = new URL(href, location.href);
    for (const name of ['skip', 'take', 'page']) url.searchParams.delete(name);
    url.searchParams.sort();
    return `${url.origin}${url.pathname}?${url.searchParams}`;
  };
  window.__salePriceAllPages = {
    // requestUrl: any of the site's page requests for the result set; items: all of its products, already sorted
    use(requestUrl, items) {
      allPages = { key: resultSetKey(requestUrl), items };
    },
    clear() {
      allPages = null;
    }
  };

  // a products API response with its items sorted (or replaced by their slice of a result set sorted across all pages),
  // or as it was if it isn't one
  function sortResponse(body, requestUrl) {
    if (!Array.isArray(body?.items)) return body;
    if (allPages && resultSetKey(requestUrl) === allPages.key) {
      const params = new URL(requestUrl, location.href).searchParams;
      const skip = parseInt(params.get('skip'), 10) || 0;
      const take = parseInt(params.get('take'), 10) || body.items.length;
      body.items = allPages.items.slice(skip, skip + take);
      body.count = body.items.length;
      body.total = allPages.items.length;
      return body;
    }
    sortByDiscount(body.items);
    return body;
  }

  // 2. later results, from the API - the site uses XMLHttpRequest. Its response is read through responseText/response,
  // so those are replaced on each product request with ones giving the sorted response, once it has fully loaded.
  const originalOpen = XMLHttpRequest.prototype.open;
  const original = name => Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, name).get;
  const originalResponseText = original('responseText');
  const originalResponse = original('response');
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (String(method).toUpperCase() === 'GET' && PRODUCT_REQUEST.test(String(url))) {
      const xhr = this;
      const requestUrl = new URL(url, location.href).href;
      let sorted = null;
      const loaded = () => xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300;
      // parsed (and sorted) once, on first read
      const sortedText = () => {
        if (sorted === null) {
          try {
            sorted = JSON.stringify(sortResponse(JSON.parse(originalResponseText.call(xhr)), requestUrl));
          } catch {
            sorted = originalResponseText.call(xhr);
          }
        }
        return sorted;
      };
      Object.defineProperty(xhr, 'responseText', {
        configurable: true,
        get: () => (loaded() ? sortedText() : originalResponseText.call(xhr))
      });
      Object.defineProperty(xhr, 'response', {
        configurable: true,
        get() {
          if (!loaded()) return originalResponse.call(xhr);
          // json responses are already parsed by the browser - sorted in place
          if (xhr.responseType === 'json') return sortResponse(originalResponse.call(xhr), requestUrl);
          return xhr.responseType === '' || xhr.responseType === 'text' ? sortedText() : originalResponse.call(xhr);
        }
      });
    }
    return originalOpen.call(this, method, url, ...rest);
  };

  // ...and fetch, in case the site ever switches to it
  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await originalFetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input?.url;
    const method = init?.method ?? input?.method ?? 'GET';
    if (String(method).toUpperCase() !== 'GET' || !PRODUCT_REQUEST.test(String(url)) || !response.ok) return response;
    try {
      const body = sortResponse(await response.clone().json(), new URL(url, location.href).href);
      return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch {
      return response;
    }
  };
})();
