// "Sort All Pages by Discount" - injected into the page (main world, so it can use the page's own network functions) by
// popup.js, after discount.js. Sorts every result of the page's results (sale items, a search, a department, ...) by
// discount while keeping the site's own pagination: page 1 then has the best deals of all of them, page 2 the next best,
// and so on.
// How: clicks one of the site's page buttons and holds the product request the site makes for it; re-requests that same
// URL (so any filters/sorting chosen are kept) 100 results at a time until it has them all; sorts them; and hands them to
// sortResults.js, which answers the site's page requests for these results with their slice of the sorted list. Then lets
// the held request go, and shows page 1.
// If the site offers a department breakdown for those results, a dialog lets the user leave departments out first - only
// the ticked ones are requested (server-side filter, so fewer requests).
(async () => {
  const LOG = '[Sort All Pages]';
  // site groupings in the department list that aren't real departments
  const NOT_DEPARTMENTS = ['{{root-facet}}', 'featured shops'];
  // the API rejects anything above 100
  const TAKE = 100;
  // the API fails in bursts - with waits capped at 15s this retries for ~5 minutes
  const MAX_RETRIES = 25;
  // requests at a time - the API struggles with bursts
  const CONCURRENCY = 2;
  const GRID = 'section[aria-labelledby="productGrid__title"]';
  const CARD = 'article[data-testid^="ProductCardWrapper-"]';
  const PAGE_1 = '[data-testid="pageOption-link-testId-1"]';
  // the product list requests seen so far: /promotions/products, /search, /categories/<id>/search
  const PRODUCT_REQUEST = /^https:\/\/storefrontgateway\.shoprite\.com\/api\/.*\/(products|search)\?.*\bskip=/;
  // for text only screen readers get
  const VISUALLY_HIDDEN = { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' };

  const log = (...args) => console.log(LOG, ...args);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  // checks every 200ms until check() gives something, or gives null after timeout ms
  async function waitFor(check, timeout) {
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(200)) {
      const found = check();
      if (found) return found;
    }
    return null;
  }

  // Set until the dialog is closed (done, failed or cancelled) - the popup disables its button while it is. Checked here
  // too in case it's started from two popups at once.
  if (window.__salePriceSortAllRunning) return;
  window.__salePriceSortAllRunning = true;
  let interceptor = null;
  let dialogCount = 0;
  // where focus goes back to when the dialog is closed
  const previousFocus = document.activeElement;
  const progress = showProgress();

  try {
    const grid = document.querySelector(GRID);
    if (!grid) throw new Error('There are no search results on this page.');
    // set up by sortResults.js when the page loads - missing if the extension was updated since
    const allPages = window.__salePriceAllPages;
    if (!allPages) throw new Error('The extension has been updated since this page was loaded.');
    const find = selector => grid.querySelector(selector) ?? document.querySelector(selector);
    const enabled = element => (element && !element.disabled ? element : null);
    // page 1's button when on another page (the held request is then for page 1 itself), otherwise Next/Previous
    const pageButton =
      enabled(find(PAGE_1)) ?? enabled(find('button[aria-label="Next Page"]')) ?? enabled(find('button[aria-label="Previous Page"]'));
    if (!pageButton) {
      progress.finish('All results are already on this page, sorted by discount.');
      return;
    }
    // a previous sort of these same results would answer our own requests below with its slices
    allPages.clear();

    // 1. catch the site's own product request, and hold it while we fetch everything
    interceptor = interceptNextProductRequest();
    progress.step('Finding the results request');
    pageButton.click();
    const held = await Promise.race([interceptor.caught, sleep(15000).then(() => null)]);
    if (!held) throw new Error("The page didn't ask for new results (it may have that page cached).");

    try {
      // 2. one tiny request for the site's department breakdown of these results - if it has one (sale items and searches
      // do, a department's own page doesn't), let the user choose which to include. Skipped if a department is already
      // picked in the site's own sidebar - the list is then that department's sub-sections instead.
      progress.step('Checking departments');
      const preview = await fetchPage(held.url, held.headers, 0, 1);
      const facets = (preview.facets?.Departments ?? []).filter(d => d.name && !NOT_DEPARTMENTS.includes(d.name.toLowerCase()));
      const departmentAlreadyPicked = facets.some(d => d._links?.facet?.selected);
      const departmentList = facets.map(d => ({ name: d.name.toLowerCase(), value: d.value, count: d.count }));
      let resultsUrl = held.url;
      let leftOut = [];
      if (departmentList.length >= 2 && !departmentAlreadyPicked) {
        log(`Choosing departments (${departmentList.length} available)`);
        progress.hide();
        const chosen = await chooseDepartments(departmentList, preview.total);
        if (!chosen) {
          log('Cancelled');
          progress.close();
          held.release();
          return;
        }
        progress.show();
        // all ticked = no filter needed. Otherwise the site's department filter, with the values joined by | - that
        // means "in any of these" (a product in a ticked and an unticked department is included). It's added alongside
        // any filters already on the request, which it combines with as "and".
        if (chosen.length < departmentList.length) {
          const url = new URL(held.url);
          url.searchParams.append('f', `Breadcrumb:${chosen.map(d => d.value).join('|')}`);
          resultsUrl = url.href;
          leftOut = departmentList.filter(d => !chosen.includes(d)).map(d => titleCase(d.name));
          log(`Leaving out: ${leftOut.join(', ')}`);
        }
      }

      // 3. fetch every result from that request, 100 at a time, CONCURRENCY requests at once. The site sometimes returns
      // the same product in two batches (and counts it in its total), so repeats are dropped by product id.
      progress.step('Fetching results');
      const first = await fetchPage(resultsUrl, held.headers, 0);
      const batches = [first];
      const requests = Math.ceil(first.total / TAKE);
      let fetched = 1;
      const report = () => {
        progress.detail(`Request ${fetched} of ${requests}`);
        progress.bar(fetched, requests);
      };
      report();
      let nextBatch = 1;
      let failed = false;
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          while (!failed && nextBatch < requests) {
            const batch = nextBatch++;
            try {
              batches[batch] = await fetchPage(resultsUrl, held.headers, batch * TAKE);
            } catch (error) {
              failed = true;
              throw error;
            }
            fetched++;
            log(`Fetched request ${fetched} of ${requests}`);
            report();
            // small gap between requests, to go easy on a struggling service
            await sleep(300);
          }
        })
      );
      const seenIds = new Set();
      const products = batches.flatMap(batch => batch.items).filter(p => !seenIds.has(p.productId) && seenIds.add(p.productId));
      log(`Got ${products.length} results (the site reported ${first.total})`);

      // 4. sort, best discount first - results with no discount keep the site's order
      const sorted = __salePriceDiscount.sortByDiscount(products);

      // 5. from now on the site's page requests for these results are answered from the sorted list (by sortResults.js).
      // Let the held request go - it's answered with its page's slice - and if it wasn't for page 1 (the page buttons
      // only offered Next), go to page 1 once that page is shown, so its response can't arrive after page 1's and
      // replace it.
      progress.step('Showing the best deals first');
      allPages.use(held.url, sorted);
      held.release();
      // a page is shown once its first card is the first product of its slice (or there are no cards, past the end)
      const shows = skip => () =>
        sorted[skip] ? find(CARD)?.getAttribute('data-testid') === `ProductCardWrapper-${sorted[skip].sku ?? sorted[skip].productId}` : !find(CARD);
      const heldSkip = parseInt(new URL(held.url).searchParams.get('skip'), 10) || 0;
      let onPage1 = heldSkip === 0;
      if (!onPage1) {
        await waitFor(shows(heldSkip), 30000);
        const page1 = await waitFor(() => enabled(find(PAGE_1)) ?? enabled(find('button[aria-label="Previous Page"]')), 30000);
        page1?.click();
        onPage1 = !!page1;
      }
      if (onPage1) onPage1 = !!(await waitFor(shows(0), 30000));
      progress.finish(
        `Sorted all ${sorted.length} results by discount - ${onPage1 ? 'page 1 has' : "go to page 1 for"} the best deals.` +
          (leftOut.length ? `\nLeft out: ${leftOut.join(', ')}.` : '')
      );
    } catch (error) {
      // if the site hasn't been answered yet, let its request go through for real, so the page isn't left loading forever
      if (!held.answered) held.release();
      throw error;
    }
  } catch (error) {
    interceptor?.restore();
    console.error(LOG, 'Failed:', error);
    progress.finish(`${error.message}\n\nPlease refresh the page and try again.`, true);
  }

  async function fetchPage(templateUrl, headers, skip, take = TAKE) {
    const url = new URL(templateUrl);
    url.searchParams.set('take', take);
    url.searchParams.set('skip', skip);
    url.searchParams.set('page', Math.floor(skip / take) + 1);
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      let status;
      try {
        const res = await fetch(url.href, { credentials: 'include', headers });
        status = res.status;
        if (res.ok) {
          const body = await res.json();
          if (Array.isArray(body.items)) {
            progress.note('');
            return body;
          }
        }
      } catch (error) {
        status = error.message;
      }
      if (attempt === MAX_RETRIES) break;
      log(`Request for results ${skip}-${skip + take} failed (${status}), retry ${attempt} of ${MAX_RETRIES - 1}`);
      progress.note(`The site isn't responding (${status}) - retrying, attempt ${attempt} of ${MAX_RETRIES - 1}`);
      await sleep(Math.min(2000 * attempt, 15000));
    }
    throw new Error(`Couldn't load results ${skip}-${skip + take} after ${MAX_RETRIES} attempts - the site may be having trouble.`);
  }

  // Replaces the page's XMLHttpRequest/fetch until the site makes its next product list request, then puts the originals
  // back. That one request is held, not sent: `caught` resolves with its url and headers, plus respond(body) to answer it
  // with our own json, or release() to send it to the network after all (`answered` is set once either has happened).
  function interceptNextProductRequest() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalFetch = window.fetch;
    let markCaught;
    const caught = new Promise(resolve => (markCaught = resolve));
    const restore = () => {
      XMLHttpRequest.prototype.open = originalOpen;
      XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
      XMLHttpRequest.prototype.send = originalSend;
      window.fetch = originalFetch;
    };
    const matches = (method, url) => String(method).toUpperCase() === 'GET' && PRODUCT_REQUEST.test(String(url));

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__salePriceUrl = matches(method, url) ? new URL(url, location.href).href : null;
      this.__salePriceHeaders = {};
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (this.__salePriceUrl) this.__salePriceHeaders[name] = value;
      return originalSetRequestHeader.call(this, name, value);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      if (!this.__salePriceUrl) return originalSend.apply(this, args);
      restore();
      const xhr = this;
      markCaught({
        url: xhr.__salePriceUrl,
        headers: xhr.__salePriceHeaders,
        answered: false,
        respond(body) {
          this.answered = true;
          const values = {
            readyState: 4,
            status: 200,
            statusText: 'OK',
            responseURL: xhr.__salePriceUrl,
            responseText: body,
            response: xhr.responseType === 'json' ? JSON.parse(body) : body
          };
          for (const [key, value] of Object.entries(values)) Object.defineProperty(xhr, key, { value, configurable: true });
          xhr.getAllResponseHeaders = () => 'content-type: application/json\r\n';
          xhr.getResponseHeader = name => (name.toLowerCase() === 'content-type' ? 'application/json' : null);
          xhr.dispatchEvent(new Event('readystatechange'));
          xhr.dispatchEvent(new ProgressEvent('load'));
          xhr.dispatchEvent(new ProgressEvent('loadend'));
        },
        release() {
          this.answered = true;
          originalSend.apply(xhr, args);
        }
      });
    };
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input?.url;
      const method = init?.method ?? input?.method ?? 'GET';
      if (!matches(method, url)) return originalFetch.apply(this, arguments);
      restore();
      return new Promise(resolve => {
        markCaught({
          url: new URL(url, location.href).href,
          headers: Object.fromEntries(new Headers(init?.headers ?? input?.headers ?? {})),
          answered: false,
          respond(body) {
            this.answered = true;
            resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
          },
          release() {
            this.answered = true;
            resolve(originalFetch.call(window, input, init));
          }
        });
      });
    };
    return { caught, restore };
  }

  // Empty modal dialog over the page, labelled by its "Sort All Pages" heading - returns the overlay (not yet added to the
  // page) and the dialog box to fill. Shared by the progress and department dialogs. Tab and Shift+Tab stay inside the
  // dialog, and Escape calls onEscape (if given). The box itself can take focus (tabindex -1), so focus can be moved into
  // a dialog that has nothing else to focus yet.
  function createDialog(onEscape) {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.5)',
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'sans-serif'
    });
    const box = document.createElement('div');
    // fits small/zoomed-in windows: never wider than the window, and scrolls as a whole when its content is taller
    Object.assign(box.style, {
      background: 'white',
      color: '#111',
      borderRadius: '8px',
      padding: '16px 20px',
      boxSizing: 'border-box',
      width: '340px',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: '80vh',
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
      outline: 'none'
    });
    const title = document.createElement('h2');
    // both dialogs are on the page at once (progress hidden while departments are chosen), so each needs its own id
    title.id = `salePriceDialogTitle${++dialogCount}`;
    title.textContent = 'Sort All Pages';
    // the site's own heading styles would otherwise apply
    Object.assign(title.style, { margin: '0', fontSize: '18px', fontWeight: 'bold', lineHeight: '1.3', color: 'inherit', fontFamily: 'inherit' });
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', title.id);
    box.tabIndex = -1;
    box.append(title);
    overlay.append(box);

    // clicking the dark backdrop would otherwise move focus out of the dialog, to the page
    overlay.addEventListener('mousedown', event => {
      if (event.target === overlay) event.preventDefault();
    });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape' && onEscape) {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...box.querySelectorAll('button, input, a[href]')].filter(el => !el.disabled && el.getClientRects().length);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) {
        event.preventDefault();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === box)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    return { overlay, box };
  }

  // Once the dialog is closed, focus goes back to where it was on the page - or, if that was nothing (the popup's button
  // was used) or it's gone, to the results heading
  function restoreFocus() {
    if (previousFocus?.isConnected && previousFocus !== document.body) {
      previousFocus.focus();
      return;
    }
    document.getElementById('productGrid__title')?.focus();
  }

  // Loading dialog over the page while it works: each step as a line (spinner while running, ✓ once done), with a detail
  // line, progress bar and retry warning for the current step. step() and note() also log to the console.
  // finish(message, failed) shows the outcome with an OK button that closes it (Escape too, once finished); close() removes
  // it straight away. Focus is moved into it when shown. Steps, warnings and the outcome are announced to screen readers
  // through a visually hidden live region (the detail line and bar change too often to announce).
  function showProgress() {
    let finished = false;
    const closeAndRestoreFocus = () => {
      overlay.remove();
      window.__salePriceSortAllRunning = false;
      restoreFocus();
    };
    const { overlay, box } = createDialog(() => finished && closeAndRestoreFocus());
    const spin = document.createElement('style');
    spin.textContent = '@keyframes salePriceSpin { to { transform: rotate(360deg); } }';
    const steps = document.createElement('div');
    Object.assign(steps.style, { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px' });
    const detail = document.createElement('div');
    Object.assign(detail.style, { fontSize: '13px', color: '#555', display: 'none' });
    const track = document.createElement('div');
    Object.assign(track.style, { height: '6px', background: '#e5e5e5', borderRadius: '3px', overflow: 'hidden', display: 'none' });
    const fill = document.createElement('div');
    Object.assign(fill.style, { height: '100%', width: '0', background: '#2e7d32', transition: 'width 0.3s' });
    track.append(fill);
    const warning = document.createElement('div');
    Object.assign(warning.style, { fontSize: '13px', color: '#a15c00', display: 'none' });
    const message = document.createElement('div');
    Object.assign(message.style, { fontSize: '14px', whiteSpace: 'pre-line', display: 'none' });
    const ok = document.createElement('button');
    ok.textContent = 'OK';
    Object.assign(ok.style, { padding: '6px 14px', cursor: 'pointer', fontWeight: 'bold', alignSelf: 'flex-end', display: 'none' });
    ok.addEventListener('click', closeAndRestoreFocus);
    // in the page (and so in the accessibility tree) from the start, so changes to it are announced
    const announcer = document.createElement('div');
    announcer.setAttribute('role', 'status');
    Object.assign(announcer.style, VISUALLY_HIDDEN);
    box.append(spin, steps, detail, track, warning, message, ok, announcer);
    document.body.append(overlay);
    box.focus();

    let current = null;
    const icon = state => {
      const span = document.createElement('span');
      Object.assign(span.style, { width: '14px', height: '14px', flex: 'none', textAlign: 'center', lineHeight: '14px', fontWeight: 'bold' });
      if (state === 'active') {
        Object.assign(span.style, {
          boxSizing: 'border-box',
          border: '2px solid #2e7d32',
          borderTopColor: 'transparent',
          borderRadius: '50%',
          animation: 'salePriceSpin 0.8s linear infinite'
        });
      } else {
        span.textContent = state === 'done' ? '✓' : '✕';
        span.style.color = state === 'done' ? '#2e7d32' : '#b00020';
      }
      return span;
    };
    const setText = (element, text) => {
      element.textContent = text;
      element.style.display = text ? '' : 'none';
    };
    const endStep = state => {
      if (!current) return;
      const replacement = icon(state);
      current.icon.replaceWith(replacement);
      current.row.style.color = '#555';
      current = null;
    };
    const progress = {
      step(text) {
        log(text);
        announcer.textContent = text;
        endStep('done');
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', gap: '8px', alignItems: 'center' });
        const label = document.createElement('span');
        label.textContent = text;
        current = { row, icon: icon('active') };
        row.append(current.icon, label);
        steps.append(row);
        progress.detail('');
        progress.bar(null);
        progress.note('');
      },
      detail: text => setText(detail, text),
      // done of total, or no bar if total is unknown
      bar(done, total) {
        track.style.display = total ? '' : 'none';
        if (total) fill.style.width = `${Math.min(100, (done / total) * 100)}%`;
      },
      note(text) {
        if (text) {
          log(text);
          announcer.textContent = text;
        }
        setText(warning, text);
      },
      finish(text, failed = false) {
        finished = true;
        endStep(failed ? 'failed' : 'done');
        progress.detail('');
        progress.bar(null);
        progress.note('');
        setText(message, text);
        message.style.color = failed ? '#b00020' : '#111';
        announcer.textContent = failed ? `Failed: ${text}` : text;
        ok.style.display = '';
        overlay.style.display = 'flex';
        ok.focus();
      },
      hide: () => (overlay.style.display = 'none'),
      show() {
        overlay.style.display = 'flex';
        box.focus();
      },
      close: closeAndRestoreFocus
    };
    return progress;
  }

  // the site's department names are lowercase - capitalize each word for display
  function titleCase(name) {
    return name.replace(/\b\w/g, c => c.toUpperCase());
  }

  // Dialog over the page listing the site's departments for these results, all ticked to start. Resolves with the ticked
  // departments ({ name, value, count } from departmentList), or null if cancelled.
  function chooseDepartments(departmentList, total) {
    return new Promise(resolve => {
      // Escape is Cancel
      const { overlay, box } = createDialog(() => finish(null));
      const intro = document.createElement('div');
      intro.textContent = `${total} results. Choose the departments to include - a product in more than one department is included if any of them is ticked (so counts can add up to more than the total).`;
      Object.assign(intro.style, { fontSize: '13px', flexShrink: '0' });

      // The buttons and checkboxes as one group named by the visible "Departments" - screen readers say it on entering
      // the group. A div with role="group", as Chrome keeps a <fieldset>'s contents at full height, so the list couldn't
      // scroll.
      const group = document.createElement('div');
      group.setAttribute('role', 'group');
      // never squeezed (flexShrink 0) - when the dialog runs out of room, the dialog scrolls instead
      Object.assign(group.style, { display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: '0' });
      const legend = document.createElement('div');
      legend.id = `salePriceDepartmentsLabel${dialogCount}`;
      legend.textContent = 'Departments';
      Object.assign(legend.style, { fontSize: '14px', fontWeight: 'bold' });
      group.setAttribute('aria-labelledby', legend.id);
      // Select all / Select none change every checkbox at once - said here, as nothing else would announce it. Cleared
      // just before each message (so pressing the same button again is announced again) and a second after it (some
      // screen readers miss text that's removed straight away).
      const status = document.createElement('div');
      status.setAttribute('role', 'status');
      Object.assign(status.style, VISUALLY_HIDDEN);
      let clearStatus;
      const announce = text => {
        clearTimeout(clearStatus);
        status.textContent = '';
        setTimeout(() => {
          status.textContent = text;
          clearStatus = setTimeout(() => (status.textContent = ''), 1000);
        }, 50);
      };

      const toggles = document.createElement('div');
      Object.assign(toggles.style, { display: 'flex', gap: '8px' });
      const list = document.createElement('div');
      // as tall as its departments, up to 40% of the window - but never capped below 7.5em (~5 rows), so it stays usable
      // in small or zoomed-in windows (the dialog scrolls instead). Past its cap it scrolls.
      Object.assign(list.style, { overflowY: 'auto', maxHeight: 'max(7.5em, 40vh)', border: '1px solid #ddd', borderRadius: '4px', padding: '6px 8px' });
      const checkboxes = departmentList.map(({ name, count }) => {
        const row = document.createElement('label');
        Object.assign(row.style, { display: 'flex', gap: '8px', alignItems: 'center', padding: '3px 0', fontSize: '14px', cursor: 'pointer' });
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.addEventListener('change', updateSortButton);
        const text = document.createElement('span');
        text.textContent = `${titleCase(name)} (${count})`;
        row.append(checkbox, text);
        list.append(row);
        return checkbox;
      });
      for (const [label, checked, message] of [
        ['Select all', true, 'All departments selected.'],
        ['Select none', false, 'All departments cleared.']
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        Object.assign(button.style, { padding: '3px 10px', fontSize: '13px', cursor: 'pointer' });
        button.addEventListener('click', () => {
          checkboxes.forEach(c => (c.checked = checked));
          updateSortButton();
          announce(message);
        });
        toggles.append(button);
      }

      const buttons = document.createElement('div');
      // in the normal flow after the list, so they never cover it
      Object.assign(buttons.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', flexShrink: '0' });
      const finish = chosen => {
        overlay.remove();
        resolve(chosen);
      };
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => finish(null));
      const sort = document.createElement('button');
      sort.textContent = 'Sort results';
      Object.assign(sort.style, { fontWeight: 'bold' });
      sort.addEventListener('click', () => finish(departmentList.filter((_, i) => checkboxes[i].checked)));
      // nothing ticked would mean no results
      function updateSortButton() {
        sort.disabled = !checkboxes.some(c => c.checked);
      }
      for (const button of [cancel, sort]) Object.assign(button.style, { padding: '6px 14px', cursor: 'pointer' });
      buttons.append(cancel, sort);

      group.append(legend, toggles, list);
      box.append(intro, group, buttons, status);
      document.body.append(overlay);
      box.focus();
    });
  }
})();
// the script's result: not the promise above, which executeScript would wait for - the popup only needs to know it started
undefined;
