// Shows more items per page than the site's 30 on sale items, search results and department pages, by setting take=<n> in
// the page URL - the site reads it and updates its pagination to match. <n> is the "Items per page" popup setting (default 50; the site's API allows at most 100).
// Runs before the page builds, so the 30-item version normally never shows.
const DEFAULT_ITEMS_PER_PAGE = 50;
const MAX_ITEMS_PER_PAGE = 100;
// remembers the URL we just redirected to, so if the site ever stopped honoring take we'd stop instead of reloading forever
const REDIRECT_KEY = 'salePrice-pageSizeRedirect';
let itemsPerPage = DEFAULT_ITEMS_PER_PAGE;

function ensurePageSize() {
  // sale items, search results and department pages - the site honors take on all three
  if (!/\/rsid\/\d+\/(promotions|results|categories\/)/.test(location.pathname)) return;
  const url = new URL(location.href);
  const page = parseInt(url.searchParams.get('page') ?? '1', 10) || 1;
  if (url.searchParams.get('take') === String(itemsPerPage)) {
    sessionStorage.removeItem(REDIRECT_KEY);
    return;
  }
  url.searchParams.set('take', itemsPerPage);
  // stay on the same page number - skip has to match the new page size (page 3 at 30 per page was skip=60)
  if (url.searchParams.has('skip')) url.searchParams.set('skip', (page - 1) * itemsPerPage);
  if (sessionStorage.getItem(REDIRECT_KEY) === url.href) return;
  sessionStorage.setItem(REDIRECT_KEY, url.href);
  // replace rather than navigate, so the old URL doesn't end up in the back button's history
  location.replace(url.href);
}

function setItemsPerPage(value) {
  const n = parseInt(value, 10);
  itemsPerPage = n >= 1 ? Math.min(n, MAX_ITEMS_PER_PAGE) : DEFAULT_ITEMS_PER_PAGE;
}

chrome.storage.sync.get(['itemsPerPage'], data => {
  setItemsPerPage(data.itemsPerPage);
  ensurePageSize();
});
// a new setting from the popup applies to the open page straight away
chrome.storage.onChanged.addListener(changes => {
  if (!changes.itemsPerPage) return;
  setItemsPerPage(changes.itemsPerPage.newValue);
  ensurePageSize();
});

// the site can switch to the promotions page without a full page load (clicking through its menus), so also check
// whenever the URL changes - the Navigation API fires this for those in-page URL changes as well as back/forward
navigation.addEventListener('currententrychange', ensurePageSize);
