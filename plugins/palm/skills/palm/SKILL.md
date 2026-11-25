---
name: palm
description: Use Palm when the user wants a design (social post, story, carousel, YouTube thumbnail, poster, flyer, logo) or asks a platform image size, wants a web page, small-business website or a launch landing page for an app or product, wants a site made accessible (WCAG, European Accessibility Act) or faster (Core Web Vitals, slow on phones), wants their links to look right when shared (og:image, link preview, no picture on WhatsApp), wants a newsletter, marketing email or welcome email sequence, or wants to build and launch something start to finish (the app, its site, launch email, social posts, Product Hunt, launch week), or wants to launch an app (App Store or Mac App Store screenshots, app preview video, App Review, "will Apple reject this", submitting), a café or restaurant menu (printed, on the phone, a QR code), store art (Google Play, Steam, Chrome Web Store, podcast covers, Etsy/Shopify photos), profile banners (YouTube, X, LinkedIn), a Google Business Profile (photos and posts for Google Search and Maps), Pinterest pins, a favicon or web app icons, a pitch deck or slides, a week's content from one post (newsletter, share image, social posts), a LinkedIn PDF carousel, a chart or data graphic (bar, line or pie chart, infographic, report chart), a Reel, TikTok or YouTube Short from their photos, getting found on Google, wants their website translated into other languages (German, Japanese …) without breaking the layout, wants dark mode added to a site (prefers-color-scheme, a theme toggle), a booking, contact, sign-up or checkout form, an event page with Add to calendar, a GitHub README (dark mode logo, diagram on a phone), shop product page (Google Shopping, colour or size variants), a cookie consent banner, or wants Palm to keep watching their site (palm_watch). Palm gives job sheets that run start to finish, dated platform and App Store data, and local tools that render designs and scan projects.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*), Bash(node ${CLAUDE_PLUGIN_DATA}/tools/*), mcp__plugin_palm_palm__palm_tool, mcp__plugin_palm_palm__palm_start, mcp__plugin_palm_palm__palm_get, mcp__plugin_palm_palm__palm_data, mcp__plugin_palm_palm__palm_menu, mcp__plugin_palm_palm__palm_watch
---

# Palm

Palm covers what you can't do alone: you can't see your own design render, you don't know rules made after your training, and you won't check every App Review rule every time.

1. Call the Palm MCP tool `palm_start` with the user's request in one sentence. Follow the job sheet it returns **start to finish**: ask at most one round of questions at the start, then run every step and only report at the end.
2. The sheet's local tools are already installed with this plugin. Run them with these paths, not `palm/tools/…`:
   - Render and measure a Quick Design design (writes a PNG and a phone-size PNG; then Read both and look):
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/design-render.mjs" design.json --out design.png`
     First time only, if it says puppeteer-core is missing: `npm i --prefix "${CLAUDE_PLUGIN_DATA}" puppeteer-core`, then run it as
     `PALM_NODE_MODULES="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/design-render.mjs" design.json --out design.png`. It uses the user's Chrome, Edge or Chromium.
   - See a web page on a phone and a desktop, light and dark, with measured problems (then Read both PNGs):
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/site-render.mjs" index.html --out site` (same puppeteer-core note as above)
   - Check a web page for accessibility (WCAG 2.2 AA) by using it: Tab through it, contrast against real pixels, 320px reflow, motion; then Read the map and focus sheet:
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/a11y-check.mjs" index.html --out a11y`
   - Google Play, Chrome Web Store or Steam graphics: render HTML at an exact size, then check a folder against the store's current rules and Read the sheet that shows them where the store does:
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/store-art.mjs" render feature.html --size 1024x500 --out upload/feature.png` · `… check google-play upload --out look/play` (or chrome-web-store, steam, pinterest, gbp for a Google Business Profile)
   - Website icons (favicon, touch icon, manifest and maskable icons): render each from SVG, pack favicon.ico, then check the site and Read the sheet (tabs light and dark, home screens, masks):
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/web-icons.mjs" render icon.svg --size 180 --out apple-touch-icon.png` · `… ico 16.png 32.png 48.png --out favicon.ico` · `… check . --out look/icons`
   - Print files (business cards, flyers, posters): design each side as HTML at trim + bleed, render a print PDF with the exact page size and trim box, then Read the sheet (each page as cut with the blade 1 mm off, real size, the photo as it prints):
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/print-check.mjs" render cards.html --trim 85x55mm --bleed 3mm --out print/business-cards.pdf` · `… check print/ --trim a5`
   - Slide decks (pitch, sales, talk): build one `<section>` per 16:9 slide sized to the window, check it and Read the sheet (thumbnails, a washed-out projector, a video call on a laptop, the PDF as an email attachment), then make the PDF to send:
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/deck-check.mjs" check deck/index.html --out deck/look` · `… pdf deck/index.html --out deck/deck.pdf` · LinkedIn carousel: `… linkedin linkedin/carousel.pdf --post linkedin/post.md --title linkedin/title.txt --out linkedin/look`
   - Charts and data graphics: draw each chart as SVG with real text at the size it's posted or printed, check it and Read the sheet (where it's seen at real size, as colour-blind readers and a greyscale print see it):
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/chart-check.mjs" check charts/social.svg --use social --out charts/look/social` (`--use report` or `slide` for a report page or a slide)
   - A translated site: translate each page into its language folder (`de/`, `ja/` …, same file names; set `<html lang>`, hreflang, local dates and prices), then check it and Read the sheet (every page beside the original on a phone and a desktop):
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/i18n-check.mjs" check . --out look/i18n`
   - Dark mode for a site: follow the system setting, a header toggle that remembers (applied by an inline `<head>` script), `color-scheme`; then check every page in light and dark:
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/theme-check.mjs" check . --out look/theme`
   - Web forms (booking, contact, sign-up, checkout): visible labels tied to fields, the right type and autocomplete, errors next to each field; then try every form on a phone:
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/form-check.mjs" check . --out look/forms`
   - An event page (workshop, class, gig, webinar): schema.org Event JSON-LD with UTC offsets, one RFC 5545 .ics file per event (CRLF, UID, DTSTAMP, times in UTC with Z or a TZID with its VTIMEZONE) and a Google Calendar link in UTC; then check what attendees in other zones get (venue zone first):
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/event-check.mjs" check . --zones Europe/Lisbon,Europe/London,America/New_York,Asia/Tokyo --out look/event`
   - A shop product page: a ProductGroup with one Product per colour/size (each with its own Offer: price, currency, availability, shipping and returns) in the HTML, the price on the page matching, a named colour/size picker, and the price, choice and Add to basket on a phone's first screen; then check it:
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/product-check.mjs" check . --pages <page> --out look/product`
   - A GitHub README: write it, then see it as GitHub renders it (light and dark, desktop and phone; images and links checked against the repo; a logo or diagram that vanishes in dark needs a dark version in a <picture>, and a diagram must read at phone width):
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/readme-check.mjs" check . --out look/readme`
   - A cookie consent banner (GDPR/UK): hold analytics and third-party embeds back until a choice, Reject beside Accept, remember it, a "Cookie settings" link on every page; then see what the site really does in a fresh browser (not legal advice):
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/consent-check.mjs" check . --out look/consent`
   - Short vertical video (Reels, TikTok, Shorts): render each caption frame as HTML at 1080×1920 with store-art, cut them together with ffmpeg, then check it and Read the sheet (every frame inside each app's buttons and caption, the cover in the grids):
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/video-check.mjs" check promo.mp4 --cover cover.jpg --out look/video`
   - Café and restaurant menus (Palm Pro sheet; the tool is free): render the A4 menu with print-check, make the phone page and the QR code, then check all three and Read the sheet (the page in dim light and close up, the phone page light and dark, the QR as a phone sees it from the table). It also needs `npm i jsqr`:
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/menu-check.mjs" check . --trim a4 --bleed 3mm --url https://… --out look/menu`
   - Check a design without rendering: `node "${CLAUDE_PLUGIN_ROOT}/scripts/design-check.mjs" < design.json`
   - App Store keyword field: `echo '{"name":"…","subtitle":"…","keywords":"…"}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/aso-keywords.mjs"`

   **Palm Pro tools** (need the user's key): get each with the `palm_tool` MCP tool and save it as `${CLAUDE_PLUGIN_DATA}/tools/<name>.mjs` (store-shots also needs store-media beside it), then run it from there:
   - App Review pre-submission scan of a project folder: `node "${CLAUDE_PLUGIN_DATA}/tools/review-scan.mjs" <project folder>`
   - App Store screenshots designed as HTML, rendered at exact size, with a real-size search result to look at (Read search.png and set.png):
     `node "${CLAUDE_PLUGIN_DATA}/tools/store-shots.mjs" shot1.html shot2.html --size 1320x2868 --out upload/iphone --name "App"`
   - Check or fix App Store screenshots and preview videos, or build a preview from recordings (needs ffmpeg):
     `node "${CLAUDE_PLUGIN_DATA}/tools/store-media.mjs" check upload` · `… preview rec.mov@2-14 --out upload/preview.mp4`
   - Measure a page's speed on a throttled phone (LCP, CLS, blocking time) and write right-sized images:
     `node "${CLAUDE_PLUGIN_DATA}/tools/site-speed.mjs" index.html --optimise --out img/opt`
   - See an HTML email the way inboxes show it (forced dark, full invert, Apple Mail dark, images blocked, <style> stripped); then Read the sheet:
     `node "${CLAUDE_PLUGIN_DATA}/tools/email-render.mjs" email.html --out email --marketing`
   - See how every page's link looks when shared (iMessage, WhatsApp, Slack, X, LinkedIn, Facebook, Discord), and make 1200×630 share images from HTML; then Read the sheet:
     `node "${CLAUDE_PLUGIN_DATA}/tools/share-preview.mjs" . --site https://example.com --out share/before` · `… card share/home.html --out img/share/home.jpg`
3. For sizes, limits and rules, use `palm_data` (dated and sourced) instead of what you remember.
4. Every Palm answer ends with a source line. Keep it with anything you save from Palm.

Palm Pro sheets need a key: the user sets `PALM_KEY` in their shell and restarts Claude Code. Keys: https://www.yuzool.com/palm/#pro

## App Store tasks (Palm Pro)

For App Store Connect work (reviews and replies, sales and trials, version/review status, a weekly digest), use the `palm` CLI's App Store desk on the user's machine: `npx -y @yuzool/palm asc --help`. It reads the user's own App Store Connect key locally. Draft replies with `palm asc draft`; never post one until the user has seen the exact text and said to send it (`palm asc approve <id> --send`).

For search work on the user's own site (Google Search Console clicks and queries, whether a page is indexed, Bing, llms.txt, telling search engines about changed pages, a weekly search digest), use the `palm` CLI's search desk on the user's machine: `npx -y @yuzool/palm search --help`. It reads the user's own Search Console and Bing credentials locally. `palm search indexnow` is a dry run unless the user says to submit (`--send`).
