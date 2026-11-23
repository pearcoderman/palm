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
| App Store screenshots + preview video | 17 of 18 | Pro |
| Mac App Store screenshots | 14 of 18 | Pro |
| Link previews (iMessage, WhatsApp, Slack, X, LinkedIn…) | 17 of 18 | Pro |
| Idea to launch: app, page, link, email, posts, Product Hunt, launch week | 16 of 18 (measured 3 of 3 vs 0 of 3) | Pro |
| Launch landing page for an app or product | 16 of 18 | Pro |
| Newsletter / marketing email | 16 of 18 (measured 100 vs 64–70) | Pro |
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
| Social profile kit (avatar + YouTube, X, LinkedIn, Facebook banners) | 13 of 18 (measured 3 of 3 vs 0 of 3) | Free |

## What's in it

**Free (in this plugin):**
- `design-render`: renders a design with the real fonts at the real size and measures every line (collisions, split words, text too small for a phone).
- `site-render`: a web page on a phone and a desktop, light and dark, measured (sideways scrolling, contrast, tap targets, covered headings).
- `a11y-check`: WCAG 2.2 AA by using the page: tabs through it and photographs every focus state, contrast against the real pixels behind text, 320px reflow, motion.
- `store-art`: Google Play, Chrome Web Store, Steam, Apple Podcasts, Etsy and Shopify graphics checked against each store's current rules (sizes, alpha, banned words, Steam's 2024 capsule sizes) and drawn where the store shows them; renders HTML at exact sizes.
- `web-icons`: a site's favicon, Apple touch icon and manifest/maskable icons checked (tags, sizes, transparency, the maskable safe zone, contrast on light and dark tabs) and drawn in browser tabs, on iPhone and Android home screens and in the install prompt; renders SVG to PNG and packs favicon.ico.
- `design-check`, `aso-keywords`, and dated, sourced data: platform image sizes and limits (Instagram 3:4, 5 hashtags, YouTube 3840×2160, LinkedIn's 2026 cover…), App Store specs.

**Palm Pro ($15/month or $150/year, 7-day free trial), fetched with your key:**
- `store-shots` + `store-media`: App Store screenshots at exact size, seen in a real-size search result; checks and builds app preview videos (886×1920, 15–30 s, audio track).
- `email-render`: your email in forced dark mode, full invert, Apple Mail dark, images blocked and `<style>` stripped; Gmail clipping, unsubscribe.
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
