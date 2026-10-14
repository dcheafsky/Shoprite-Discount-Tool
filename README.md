# ShopRite Discount Tool

A Chrome extension I made for my own benefit when grocery shopping on ShopRite's website. It gradually grew in scope until I felt it was worth sharing professionally.

*Not affiliated with or endorsed by ShopRite.*

## Installing

1. Download or clone this folder.
2. In Chrome, go to `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open [shoprite.com](https://www.shoprite.com) and browse the weekly sale items, a search or a department. The extension's popup has the "Sort All Pages by Discount" button and your preferences.

## What it does

<img width="1296" height="587" alt="image" src="https://github.com/user-attachments/assets/f0a9545e-d88a-4a43-82a6-35ff3c59161d" />

- Adds a "% off" badge to every product, rated as a good, average or bad deal by your own thresholds.
- Sorts each page of results so the best discounts come first.
- **Sort All Pages by Discount:** sorts every result of a search, the weekly sale items or a department across all of its pages, so page 1 has the best deals of everything. You can also filter by departments, omitting any that would appear in the results (for example, including everything except the "Pets" & "Floral" departments).
- Lets you choose how many results show per page (the site's 30, up to 100).
- Optionally puts your favorites, then items you've bought before, first (when logged in), each still sorted by discount.

<img width="498" height="570" alt="image" src="https://github.com/user-attachments/assets/8516fa49-53e0-43e3-a098-0a7423028afa" />

## How it came together

It started off very simple: grab the prices from the product cards on the page using reliable selectors, use some simple logic to calculate each item's discount, and append it as a visible badge.

From there, I brought in Claude to add functionality. It worked out how the site talks to its API, and engaged with it directly to do things that aren't possible at the page level:

- **Sorting in the site's own data.** Results are sorted before the site renders them, so the site still draws its own product cards, just in a better order.
- **Sorting across every page.** It requests every result for the current search 100 at a time, sorts them all by discount, then answers the site's own page requests with the right slice. The site's pagination, filters and product cards keep working as normal.
- **Leaving out departments.** The site's filters can only narrow results down to one department. Mine can exclude any of them, which also means fewer requests.
- **More results per page,** from the site's default of 30 up to 100.

I set the direction for each feature and tested it on the live site, validating the correct scope of execution, and looking for any niche issues that arose.

## Decisions along the way

- My first take on "see the best deals across all pages" put every result on a single page. It worked, but with thousands of products the site's own code slowed to a crawl, so I replaced it with sorting across the site's existing pagination. Only one page of products is ever loaded, so the site stays fast.
- Selectors use the site's test hooks (`data-testid`) and ARIA attributes rather than its generated class names, so they're much less likely to break when the site updates.
- The site's API can be unreliable, so requests retry with backoff, and duplicate products the API sometimes returns are filtered out.

## Customization

I wanted to keep this customizable, so I added a preferences section to the popup where you can choose how many results you want per page, what you consider a good or bad discount (which changes the badges), and whether your favorites and items you've bought before should come first.

<img width="307" height="438" alt="image" src="https://github.com/user-attachments/assets/b2c8f292-21c0-4b60-a163-a9d2908d3fc8" />


## Accessibility

I care a lot about accessibility, so I made sure every point of interaction works with assistive technology.

**Popup**
- The preferences section is an accordion (a button with `aria-expanded`) that opens a labelled form.
- Form errors appear inline under each field, are tied to it for screen readers, and focus moves to the first field with a problem. For example, the "bad" discount can't be higher than the "good" one.
- Status messages ("Preferences saved.") are announced through live regions.
- While a sort is running, its button is disabled with a visible explanation, also tied to the button for screen readers.

**On-page dialogs**
- The progress and department dialogs are proper modal dialogs: focus moves into them, stays inside while they're open, Escape closes them, and focus returns to the page afterwards.
- Progress steps and results are announced, and so is "Select all" / "Select none" in the department list, which is grouped under a visible "Departments" label.
- I also considered reflow and resizing, so the dialogs stay usable in small windows and at 400% zoom. The dialog scrolls rather than squeezing the department list down to nothing.

**Results and badges**
- Product sorting was originally done with CSS `order`, which only changed what's shown on screen. Screen reader and keyboard users still got the site's original order, so I had Claude sort the results at the data level instead. Now the real page order matches what's shown.
- I wanted a non-color method to tell a good deal from a bad one, so each badge also has an up chevron, a dash or a down chevron. The symbols are hidden from screen readers, which hear "good deal", "average deal" or "bad deal" instead.
- A small hidden separator keeps screen readers from reading the badge as part of the price ("$3.99, 45% off, good deal" rather than "$3.9945% off").

## License

MIT - see [LICENSE](LICENSE).
