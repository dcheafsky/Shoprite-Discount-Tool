let goodThreshold = 40;
let badThreshold = 15;
let debounceTimer = null;

// The site's data-testid attributes for important card elements
const CARD = 'article[data-testid^="ProductCardWrapper-"]';
// holds the price element - the first dollar amount in it is the current price
const PRICE = '[data-testid="productCardPricing-div-testId"]';
const WAS_PRICE = '[data-testid="ProductCardWasPrice-testid"]';
// the deal/info badges, e.g. "On Sale! Limit 4", "4 for $6.00"
const BADGE = '[data-testid^="promotionBadge-"]';

// whole percent off for a card, or NaN if there's no discount (rule in discount.js). Every badge is checked - when logged
// in, a "Previously Purchased" badge can come before the deal badge.
function getPercentOff(card, saleEl) {
  const badges = [...card.querySelectorAll(BADGE)].map(badge => badge.textContent);
  return Math.round(__salePriceDiscount.percentOff(saleEl.textContent, card.querySelector(WAS_PRICE)?.textContent, badges));
}

// for text only screen readers get
const VISUALLY_HIDDEN = { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' };

// How good a deal is, by the popup's thresholds - shown by color, and without color by a symbol after the "% off"
// (up chevron / dash / down chevron, as a small SVG so it looks the same in any font)
const RATINGS = {
  good: { color: '#14532d', text: 'good deal', points: '1,7 5,3 9,7' }, // dark green, up chevron
  average: { color: 'rgba(0,0,0,0.8)', text: 'average deal', points: '1,5 9,5' }, // dark gray, dash
  bad: { color: '#7f1d1d', text: 'bad deal', points: '1,3 5,7 9,3' } // dark red, down chevron
};
function ratingFor(percentOff) {
  if (percentOff >= goodThreshold) return RATINGS.good;
  if (percentOff <= badThreshold) return RATINGS.bad;
  return RATINGS.average;
}

// (re)fills a badge for its percentOff - also used when the thresholds change. Read by screen readers as
// ", 45% off, good deal": the commas keep it from running into the price before it, and the symbol is hidden from them
// (its meaning is the text after it).
function renderLabel(label) {
  const percentOff = Number(label.dataset.percentOff);
  const rating = ratingFor(percentOff);
  const srOnly = text => {
    const span = document.createElement('span');
    span.textContent = text;
    Object.assign(span.style, VISUALLY_HIDDEN);
    return span;
  };
  const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  symbol.setAttribute('viewBox', '0 0 10 10');
  symbol.setAttribute('aria-hidden', 'true');
  symbol.setAttribute('focusable', 'false');
  Object.assign(symbol.style, { width: '0.8em', height: '0.8em', marginLeft: '4px', verticalAlign: '-0.05em' });
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', rating.points);
  Object.assign(line.style, { fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' });
  symbol.append(line);
  label.replaceChildren(srOnly(', '), `${percentOff}% off`, symbol, srOnly(`, ${rating.text}`));
  label.style.background = rating.color;
}

function labelCard(card) {
  // the price element itself, so the badge goes on its own line right under the price
  const pricing = card.querySelector(PRICE);
  const saleEl = pricing?.firstElementChild ?? pricing;
  if (!saleEl) return;
  // the product link identifies which product the card is showing - the site can reuse a card element for a different
  // product when paging, so an existing label only counts if it was made for this product
  const productKey = card.querySelector('a')?.getAttribute('href') ?? '';
  const existing = card.querySelector('.discount-label');
  if (existing) {
    if (existing.dataset.productKey === productKey) return;
    existing.remove();
  }

  const percentOff = getPercentOff(card, saleEl);
  if (isNaN(percentOff)) return;

  const label = document.createElement('span');
  label.className = 'discount-label';
  label.dataset.percentOff = percentOff;
  label.dataset.productKey = productKey;
  renderLabel(label);
  // its own line under the sale price, in the normal page flow, so it never covers other content
  Object.assign(label.style, {
    display: 'block',
    width: 'fit-content',
    marginTop: '2px',
    color: 'white',
    padding: '1px 4px',
    fontSize: '14px',
    borderRadius: '4px',
    pointerEvents: 'none',
    whiteSpace: 'nowrap'
  });
  saleEl.appendChild(label);
}

// labels only cards that don't have one yet
function labelNewCards() {
  document.querySelectorAll(CARD).forEach(labelCard);
}

// re-rates existing labels (after a threshold change) and labels any new cards
function highlightDiscounts() {
  document.querySelectorAll('.discount-label').forEach(renderLabel);
  labelNewCards();
}

// the sorting scripts run in the page's main world, which can't read chrome.storage - the "favorites and previously
// purchased first" preference is copied into the page's localStorage for them (read when results are sorted, so it
// applies to results loaded from then on)
function shareMyItemsFirst(value) {
  try {
    localStorage.setItem(__salePriceDiscount.MY_ITEMS_FIRST_KEY, String(value === true));
  } catch {}
}

// thresholds from the popup's settings, kept in sync when they change
chrome.storage.sync.get(['goodThreshold', 'badThreshold', 'myItemsFirst'], data => {
  goodThreshold = data.goodThreshold ?? goodThreshold;
  badThreshold = data.badThreshold ?? badThreshold;
  shareMyItemsFirst(data.myItemsFirst);
  highlightDiscounts();
});
chrome.storage.onChanged.addListener(changes => {
  if (changes.myItemsFirst) shareMyItemsFirst(changes.myItemsFirst.newValue);
  if (!changes.goodThreshold && !changes.badThreshold) return;
  if (changes.goodThreshold) goodThreshold = changes.goodThreshold.newValue;
  if (changes.badThreshold) badThreshold = changes.badThreshold.newValue;
  highlightDiscounts();
});

// Observe DOM - ignores changes that are only our own labels being added or re-rated, so they don't trigger another pass
const observer = new MutationObserver(mutations => {
  const siteChanged = mutations.some(
    m =>
      !m.target.closest?.('.discount-label') &&
      [...m.addedNodes].some(node => !(node instanceof Element && node.classList.contains('discount-label')))
  );
  // runs at most 500ms after the first change - not reset by later changes, so a page that never stops changing
  // (carousels, lazy images) still gets labelled
  if (!siteChanged || debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    labelNewCards();
  }, 500);
});
observer.observe(document.body, { childList: true, subtree: true });
