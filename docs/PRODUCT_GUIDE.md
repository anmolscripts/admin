# Product Documentation

Open **account menu → Product Guide**, immediately below My Profile, or `/product-guide` while signed in.

The documentation contains 32 articles covering navigation, profile, customer/supplier masters, documents, payments, purchases, expenses, reports, financial years, journals, projects, history, team access, organization settings and document templates. Inventory and payroll references explicitly identify workflows currently exposed through APIs.

## Reading and finding information

Topics are grouped by feature in the left navigation. The article column contains explanatory sections, expected behaviour, terminology, considerations and related application links. **On this page** links jump directly to headings. Previous/next links support reading in sequence. Search scans permitted article content and provides excerpts and direct links to matching sections; `/` focuses it. Saved pages are stored in this browser, scoped to the current account and business. There are no quizzes, completion checklists or learning-score cards.

Section anchors derive from the article and heading title, so a shared link retains its meaning when readers have different permitted action steps. Copy link includes the current section fragment. The print button prints the currently displayed article.

## Permission boundary

`app/content/product-guide.js` defines module/action requirements for articles, action instructions, destinations and screenshots. The service filters these on the server using the same effective permissions as the application. Restricted articles and steps are absent from rendered HTML and client search data. A role name alone does not bypass permission checks. The controller checks the active account and denies unauthorized direct article, image and training-view URLs. Responses use private, no-store caching. Reload after a permission change.

The documentation does not grant access or write business data. Related app links open real screens where ordinary permissions and save rules apply.

## Images

Eight annotated images are captures of read-only synthetic training views. They contain fictional sample values, are clearly labelled, and never publish customer data. PNGs are in `app/content/product-guide-screens/`; serve them only through the protected controller. The image dialog supports 50–300% zoom, keyboard +/−, scrolling, Escape and focus return.

The supplied blue profile icon is `/images/default-avatar.png`. Header, sidebar, profile and team views use it only when an uploaded avatar is absent. Selecting and undoing a new upload preserves the existing saved photo or this fallback. No database avatar values are overwritten.

## Verification and maintenance

Update article instructions and permission requirements together when a feature changes. Keep synthetic images free of customer information. Use the isolated test database for `npm test -- product-guide modern-components default-avatar`; never run integration fixtures against production. Tests cover permission filtering, direct URL denial, section search and anchors, navigation, bookmarks, image zoom, menu placement, avatar precedence and upload undo.

This change requires no schema migration. `npm run build` uses the existing backup and production deployment workflow.
