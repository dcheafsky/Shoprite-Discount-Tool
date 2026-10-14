// The discount rule shared by content.js (product cards), sortResults.js and sortAllPages.js (the site's product data).
// Loaded into each of their worlds as one global, so it adds nothing else to the page.
globalThis.__salePriceDiscount = (() => {
  // first dollar amount in a string, e.g. "$3.99 avg/ea" -> 3.99, "$1,299.00" -> 1299
  function parseDollars(text) {
    const match = text?.match(/\$\s*([\d,]+(?:\.\d+)?)/);
    return match ? parseFloat(match[1].replace(/,/g, '')) : NaN;
  }

  // Percent off (unrounded), or NaN if there's no discount, from the displayed price strings. The "was" price counts only
  // if it's higher than the price (the site's data can repeat the price as the "was" price); otherwise the first
  // "n for $X" deal among the promotions, as a per-item price compared with the listed price.
  function percentOff(price, wasPrice, promotions = []) {
    const currentPrice = parseDollars(price);
    let previousPrice = parseDollars(wasPrice);
    let salePrice = currentPrice;
    if (!(previousPrice > currentPrice)) {
      const multi = promotions.map(text => text?.match(/(\d+)\s*for\s*\$\s*(\d+(?:\.\d+)?)/i)).find(match => match);
      if (!multi) return NaN;
      previousPrice = currentPrice;
      salePrice = parseFloat(multi[2]) / parseInt(multi[1], 10);
    }
    if (!(previousPrice > salePrice)) return NaN;
    return (1 - salePrice / previousPrice) * 100;
  }

  // percentOff for a product from the site's data (API responses and the page's preloaded state)
  function productPercentOff(product) {
    return percentOff(product?.price, product?.wasPrice, (product?.promotions ?? []).map(p => p.name));
  }

  // The popup's "favorites and previously purchased first" preference, copied into the page's localStorage by content.js
  // so the page's main world can read it straight away (chrome.storage isn't available there)
  const MY_ITEMS_FIRST_KEY = 'salePrice-myItemsFirst';
  function myItemsFirst() {
    try {
      return localStorage.getItem(MY_ITEMS_FIRST_KEY) === 'true';
    } catch {
      return false;
    }
  }

  // with the preference on: the logged-in user's favorites first, then items they've bought before, then the rest
  function groupOf(product) {
    if (product?.isFavorite === true) return 2;
    if (product?.isPastPurchased === true) return 1;
    return 0;
  }

  // Sorts list in place, best discount first - products with no discount keep the site's order, after the rest (sort is
  // stable). With the "favorites and previously purchased first" preference on, products are grouped by groupOf first,
  // each group sorted the same way. productOf gets the product data for a list item.
  function sortByDiscount(list, productOf = item => item) {
    const grouped = myItemsFirst();
    const ranks = new Map(
      list.map(item => {
        const product = productOf(item);
        const percent = productPercentOff(product);
        return [item, [grouped ? groupOf(product) : 0, isNaN(percent) ? -Infinity : percent]];
      })
    );
    return list.sort((a, b) => {
      const [groupA, percentA] = ranks.get(a);
      const [groupB, percentB] = ranks.get(b);
      return groupB - groupA || (percentA === percentB ? 0 : percentB - percentA);
    });
  }

  return { percentOff, sortByDiscount, MY_ITEMS_FIRST_KEY };
})();
