# Palm for Claude Code

**Your agent is brilliant, and blind.** It writes your design, page, email or app as code it never sees, it learned the platform rules a year ago, and it checks what it remembers to check. Palm gives it eyes, what changed, and every rule, every time. No AI runs on Palm's side; the tools run on your machine.

```
/plugin marketplace add pearcoderman/palm
/plugin install palm@yuzool
```

Then just ask: *"make an Instagram post for our bakery's Saturday sourdough"*, *"build a one-page site for my plumbing business"*, *"make my site accessible"*, *"why does our link show no picture on WhatsApp?"*, or *"build and launch my app, start to finish"*. Palm's skill picks the job sheet and runs it start to finish.

## Tested blind before it ships

Every part runs the same test: the same agent and request, with and without Palm, judged blind by a separate session that never knows which used Palm. If the agent already does the job well, we cut it (so far: App Store keywords, a web-app builder, an app-icon sheet, email deliverability and paid-social ads).

| Job | Picked blind (or measured) with Palm | Tier |
|---|---|---|
| Weekly content kit: one post → newsletter, share image, social posts and story | 18 of 18 (measured 3 of 3 vs 0 of 3) | Pro |
| Website icons (favicon, Apple touch icon, maskable) | 18 of 18 | Pro |
| Web forms on a phone (filled in, sent empty and with a wrong email, tabbed) | 18 of 18 (checks tied; judges chose errors shown next to each field) | Pro |
| Event page with Add to calendar (each calendar entry in four time zones) | 15 of 18 (calendar checks tied; judges chose the page that fits a phone) | Pro |
| Shop product page ready for Google Shopping | 18 of 18 (merchant data tied; judges chose the first phone screen with price, colour and Add to basket) | Pro |
| Cookie consent banner (fresh browser: what loads before a choice, after Reject, after Accept) | 11 of 18 (checks tied; judges split on looks) | Free |
| Dark mode for an existing website (light and dark, phone and desktop, toggle reloaded) | 18 of 18 | Pro |
| App Store screenshots + preview video | 17 of 18 | Pro |
| Mac App Store screenshots | 14 of 18 | Pro |
| Link previews (iMessage, WhatsApp, Slack, X, LinkedIn…) | 17 of 18 | Pro |
| Idea to launch: app, page, link, email, posts, Product Hunt, launch week | 16 of 18 (measured 3 of 3 vs 0 of 3) | Pro |
| Launch landing page for an app or product | 16 of 18 | Pro |
| Newsletter / marketing email | 16 of 18 (measured 100 vs 64–70) | Pro |
| Welcome email sequence (every email in six inboxes, plus the inbox list) | 17 of 18 (measured 3 of 3 vs 0 of 3) | Pro |
| Steam store and library art | 16 of 18 (measured 3 of 3 vs 2 of 3) | Pro |
| Google Play icon, feature graphic, screenshots | 15 of 18 | Pro |
| Podcast cover and episode art (Apple Podcasts) | 17 of 18 | Pro |
| Small site found on Google (titles, descriptions, canonical, structured data, sitemap) | 18 of 18 | Pro |
| Slow website made fast | 3 of 3 reached good LCP (0 of 3 without) | Pro |
| Instagram carousel | 9 of 9 | Free |
| YouTube thumbnail | 4 of 4 | Free |
| Small-business website | 6 of 9 | Free |
| Accessibility (WCAG 2.2 AA) | 3 of 3 clean (0 of 3 without) | Free |
| Chrome Web Store images | 13 of 18 | Free |
| Etsy / Shopify listing photos from your own photos | 14 of 18 | Free |
| Pinterest pins for a post or product | 18 of 18 | Pro |
| LinkedIn PDF carousel (document post) from a blog post | 16 of 18 | Pro |
| Charts and data graphics (a post and a printed report chart) | 16 of 18 (measured 2 of 3 vs 0 of 3) | Pro |
| Google Business Profile: logo, cover, photos and this week's post | 18 of 18 | Pro |
| Social profile kit (avatar + YouTube, X, LinkedIn, Facebook banners) | 13 of 18 (measured 3 of 3 vs 0 of 3) | Free |
| Print-ready business cards and flyers | 11 of 18 | Free |
| Pitch deck (projector, video call, the PDF that gets sent) | 11 of 18 (measured 3 of 3 vs 1 of 3) | Free |
| Website translated into other languages (every page beside the original, phone and desktop) | 11 of 18 | Free |
| Café menu: printed for the table, on the phone, a QR code that scans | 15 of 18 (round 2) | Pro |
| Reels, TikTok and Shorts video from your photos | 13 of 18 (measured 2 of 3 vs 0 of 3) | Free |

## What's in it

**Free (in this plugin):**
- `design-render`: renders a design with the real fonts at the real size and measures every line (collisions, split words, text too small for a phone).
- `site-render`: a web page on a phone and a desktop, light and dark, measured (sideways scrolling, contrast, tap targets, covered headings).
- `a11y-check`: WCAG 2.2 AA by using the page: tabs through it and photographs every focus state, contrast against the real pixels behind text, 320px reflow, motion.
- `store-art`: Google Play, Chrome Web Store, Steam, Apple Podcasts, Etsy and Shopify graphics, Pinterest pins in the desktop and phone feeds, and a Google Business Profile in Google Search and Maps, checked against each store's current rules (sizes, alpha, banned words, Steam's 2024 capsule sizes) and drawn where the store shows them; renders HTML at exact sizes.
- `web-icons`: a site's favicon, Apple touch icon and manifest/maskable icons checked (tags, sizes, transparency, the maskable safe zone, contrast on light and dark tabs) and drawn in browser tabs, on iPhone and Android home screens and in the install prompt; renders SVG to PNG and packs favicon.ico.
- `video-check`: a short vertical video seen inside Instagram Reels, TikTok and YouTube Shorts at phone size, with each app's buttons and caption over it; on a Mac it reads the words on screen and flags captions under an app's interface, too small or too brief to read; the cover in each profile grid; size, frame rate, length and audio. Needs ffmpeg.
- `menu-check`: a café or restaurant menu seen the way guests meet it: the printed page in daylight, dim light and close up; the phone page the QR opens at 390 px, light and dark (text cut off at the edge, prices drifting from dishes, allergen notes too small, no dark mode); and the QR code decoded from the printed page as a phone camera sees it from the table (size, quiet zone, where it points). Needs print-check beside it and `npm i jsqr`.
- `deck-check`: a slide deck (HTML or PDF) checked slide by slide at 1920×1080: text off the slide, cut off in its box or overlapping, the smallest text, words per slide, contrast against the real pixels and on a washed-out projector, a deck cut off on a 1440×900 laptop, and the PDF that gets sent (one 16:9 page per slide, backgrounds kept); drawn as presenter thumbnails, on a projector, in a video call and as an email attachment. `pdf` makes a clean 16:9 PDF. Keep print-check.mjs beside it. Its `linkedin` mode shows a LinkedIn PDF carousel in the phone and desktop feed (light and dark, the post cut at "…see more", the title over page 1, every page at the real phone size) and measures text size and words per page against LinkedIn's limits.
- `chart-check`: a chart or data graphic (SVG, HTML or PNG) seen at the size it's shown (a phone feed, a report on a laptop, a video call), as red-blind, green-blind and blue-blind readers and a greyscale print see it, and on a dark page: labels too small, overlapping or cut off, series colours people can't tell apart (CIEDE2000), a bar axis that doesn't start at zero, too many colours, WCAG contrast.
- `form-check`: every form on a site tried on a 390 px phone the way people use it: filled in, sent empty and with a wrong email, tabbed through and pasted into. Checks labels tied to fields (WCAG 1.3.1), autofill tokens for fields about the person (1.3.5, from the HTML spec's list), the phone keyboard (type/inputmode), text under 16 px that makes iPhone zoom, 24×24 tap targets (2.5.8), and errors shown next to the field and announced (3.3.1, 4.1.3); draws a sheet.
- `consent-check`: opens a site in a fresh browser each time (other sites stubbed, so nothing leaves your machine) and lists what it contacts and stores before any cookie choice, after Reject and a reload, and after Accept; measures Reject against Accept, pre-ticked boxes, the banner's share of a phone screen, the keyboard, and the way back to the choice. Sources: ePrivacy art. 5(3), the EDPB cookie banner taskforce report (2023), CNIL. Not legal advice.
- `product-check`: a shop's product page as shoppers and Google see it: Product and ProductGroup data checked against Google's merchant listing rules (price, currency, shipping and returns), the data's price against the page, the first screen on a phone, the colour or size picker tabbed through and read out, a merchant listing mock and the link card.
- `event-check`: an event page as attendees, their calendars and Google see it: schema.org Event data checked against Google's rules, every .ics file (RFC 5545) and Google Calendar link converted to the times people in other zones will see and checked against the page, the page on a phone and its link card.
- `theme-check`: a site's dark mode seen page by page in light and dark on a phone and a desktop: text and field contrast against the real pixels (WCAG 1.4.3, 1.4.11), focus rings by tabbing, transparent logos that vanish, images, embeds and code blocks that glare, color-scheme, theme-color, and a header toggle clicked, reloaded and its first frame; draws the sheet.
- `i18n-check`: a translated site (the original pages at the top, each language in a folder: `de/`, `ja/` …) seen page by page beside the original on a phone and a desktop: text clipped, cut off with "…" or spilling out of its box, the page wider than the screen, buttons wrapping to three lines, `<html lang>` missing or wrong, Japanese set in a Chinese font (from the fonts Chrome actually used), missing hreflang, text and labels left untranslated, English-format dates and numbers; draws the sheet.
- `print-check`: print-ready PDFs for business cards, flyers and posters (exact trim + bleed with the trim box set) and any PDF checked: bleed that really runs to the edge, text near the cut, photo ppi at print size, smallest text and line, embedded fonts; drawn as cut with the blade 1 mm off and at real size. Pages are drawn with Ghostscript, pdftoppm, mutool or PyMuPDF, whichever is installed.
- `design-check`, `aso-keywords`, and dated, sourced data: platform image sizes and limits (Instagram 3:4, 5 hashtags, YouTube 3840×2160, LinkedIn's 2026 cover…), App Store specs.

**Palm Pro ($15/month or $150/year, 7-day free trial), fetched with your key:**
- `store-shots` + `store-media`: App Store screenshots at exact size, seen in a real-size search result; checks and builds app preview videos (886×1920, 15–30 s, audio track).
- `email-render`: your email in forced dark mode, full invert, Apple Mail dark, images blocked and `<style>` stripped; Gmail clipping, unsubscribe; `sequence` draws a welcome series in every inbox view plus the phone inbox list.
- `share-preview`: every page's link card in seven apps, from the raw HTML; renders 1200×630 share images; draws social posts where people see them (Instagram feed and 3:4 grid, a story under the app's bars, LinkedIn, X), captions cut where each app cuts them.
- `site-speed`: Core Web Vitals measured on a throttled phone, with right-sized WebP copies.
- `review-scan`: App Review pre-submission scan of your project against the October 2026 guidelines.

- **Palm Watch**: ask your agent to watch up to 10 of your pages; Palm re-checks them daily on its server (no AI) and tells your agent what broke and what was fixed.

Set `PALM_KEY` in your shell profile and restart Claude Code. Keys: https://www.yuzool.com/palm/#pro

## Other agents

Palm is also an MCP server: `https://www.yuzool.com/palm/mcp` (Claude desktop, web and phone as a custom connector; ChatGPT; Cursor; VS Code).

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.palm]
url = "https://www.yuzool.com/palm/mcp"
bearer_token_env_var = "PALM_KEY"
```

## Guides

Free, dated and sourced guides with real before/after results: https://www.yuzool.com/palm/learn/ (App Store screenshot sizes, Instagram post size, link previews, HTML email dark mode, Core Web Vitals, accessibility and more).
