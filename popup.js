const goodInput = document.getElementById('goodThreshold');
const badInput = document.getElementById('badThreshold');
const itemsPerPageInput = document.getElementById('itemsPerPage');
const myItemsFirstInput = document.getElementById('myItemsFirst');
const prefsToggle = document.getElementById('prefsToggle');
const prefsForm = document.getElementById('prefsPanel');
const prefsStatus = document.getElementById('prefsStatus');
const sortAllBtn = document.getElementById('sortAllBtn');
const sortAllStatus = document.getElementById('sortAllStatus');
const sortAllBusy = document.getElementById('sortAllBusy');

// Sort All Pages can't be started again while its dialog is still open on the page (until done, failed or cancelled)
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!/^https:\/\/www\.shoprite\.com\//.test(tab?.url ?? '')) return;
  chrome.scripting.executeScript(
    { target: { tabId: tab.id }, world: 'MAIN', func: () => !!window.__salePriceSortAllRunning },
    results => {
      if (chrome.runtime.lastError || !results?.[0]?.result) return;
      sortAllBtn.disabled = true;
      sortAllBusy.hidden = false;
      // only now - aria-describedby still reads a hidden element
      sortAllBtn.setAttribute('aria-describedby', sortAllBusy.id);
    }
  );
});

// sorts every result of the page's search results (sale items, a search, a department) by discount, across all of its
// pages - page 1 then has the best deals (see sortAllPages.js)
sortAllBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!/^https:\/\/www\.shoprite\.com\//.test(tab?.url ?? '')) {
      sortAllStatus.textContent = 'Open a ShopRite page with search results first.';
      return;
    }
    // checks for a results grid before anything runs
    chrome.scripting.executeScript(
      { target: { tabId: tab.id }, func: () => !!document.querySelector('section[aria-labelledby="productGrid__title"]') },
      results => {
        if (!results?.[0]?.result) {
          sortAllStatus.textContent = 'There are no search results on this page.';
          return;
        }
        // main world, so it can use (and temporarily take over) the page's own network functions
        // Once started, its dialog on the page shows the progress and has focus - closing the popup lets the page (and so
        // the dialog) take keyboard and screen reader focus.
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['discount.js', 'sortAllPages.js'], world: 'MAIN' }, () => {
          if (chrome.runtime.lastError) sortAllStatus.textContent = `Couldn't start: ${chrome.runtime.lastError.message}`;
          else window.close();
        });
      }
    );
  });
});

// "Update Preferences" accordion
prefsToggle.addEventListener('click', () => {
  const expanded = prefsToggle.getAttribute('aria-expanded') === 'true';
  prefsToggle.setAttribute('aria-expanded', String(!expanded));
  prefsForm.hidden = expanded;
  clearPrefsStatus();
});

// The "Preferences saved." message fades out (100ms) before it changes and fades in when shown, so saving again visibly
// pops it in again. Each call takes over from any still fading.
let prefsStatusVersion = 0;
async function setPrefsStatus(text) {
  const version = ++prefsStatusVersion;
  if (prefsStatus.textContent) {
    prefsStatus.classList.add('fading');
    await new Promise(resolve => setTimeout(resolve, 100));
    if (version !== prefsStatusVersion) return;
  }
  prefsStatus.textContent = text;
  if (!text) return;
  prefsStatus.classList.add('fading');
  // apply the transparent start before removing it, so the transition runs
  prefsStatus.offsetWidth;
  prefsStatus.classList.remove('fading');
}
// at once, no fade - for when the form is collapsed or expanded
function clearPrefsStatus() {
  prefsStatusVersion++;
  prefsStatus.textContent = '';
}
for (const input of prefsForm.querySelectorAll('input')) input.addEventListener('blur', () => setPrefsStatus(''));

// discounts are whole percentages - number inputs otherwise accept e, +, - and . (e.g. "1e2")
for (const input of [goodInput, badInput]) {
  input.addEventListener('beforeinput', event => {
    if (event.data && /\D/.test(event.data)) event.preventDefault();
  });
}

// Load saved values
chrome.storage.sync.get(['goodThreshold', 'badThreshold', 'itemsPerPage', 'myItemsFirst'], data => {
  goodInput.value = data.goodThreshold ?? 40;
  badInput.value = data.badThreshold ?? 15;
  itemsPerPageInput.value = data.itemsPerPage ?? 50;
  myItemsFirstInput.checked = data.myItemsFirst === true;
});

// whole number from min to max, or NaN
function readWholeNumber(input, min, max) {
  const value = /^\d+$/.test(input.value) ? parseInt(input.value, 10) : NaN;
  return value >= min && value <= max ? value : NaN;
}

function setError(input, message) {
  document.getElementById(`${input.id}Error`).textContent = message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

// Validate and save. Errors are shown under their field and focus moves to the first one.
prefsForm.addEventListener('submit', event => {
  event.preventDefault();
  const good = readWholeNumber(goodInput, 0, 100);
  const bad = readWholeNumber(badInput, 0, 100);
  // the site's API allows at most 100 per page
  const itemsPerPage = readWholeNumber(itemsPerPageInput, 1, 100);

  setError(goodInput, isNaN(good) ? 'Enter a whole number from 0 to 100.' : '');
  setError(
    badInput,
    isNaN(bad)
      ? 'Enter a whole number from 0 to 100.'
      : bad > good
        ? `Bad discount can't be more than the good discount (${good}%).`
        : ''
  );
  setError(itemsPerPageInput, isNaN(itemsPerPage) ? 'Enter a whole number from 1 to 100.' : '');
  const firstInvalid = prefsForm.querySelector('[aria-invalid="true"]');
  if (firstInvalid) {
    setPrefsStatus('');
    firstInvalid.focus();
    return;
  }

  // open pages pick up the changes themselves: content.js re-rates the badges and shares the sorting preference,
  // pageSize.js reloads results with the new page size
  const myItemsFirst = myItemsFirstInput.checked;
  chrome.storage.sync.set({ goodThreshold: good, badThreshold: bad, itemsPerPage, myItemsFirst }, () =>
    setPrefsStatus('Preferences saved.')
  );
});
