---
version: alpha
name: Parley
description: "A dark navy product canvas (#0a1222) with light blue-grey text, a four-step surface ladder with hairline borders instead of shadows, and PayPal gold (#ffc439) as the single primary-action colour. Structure, type scale, spacing, radii and component rules are adapted from the 'linear.app' entry of the design-md collection (VoltAgent/awesome-design-md, MIT); the palette is Parley's own navy, blue, sky and gold. Type is Inter (600 display with negative tracking, 400 body), IBM Plex Mono for code and ids, and Lilita One for the wordmark only."

colors:
  primary: "#ffc439"          # gold: the one primary action per view
  on-primary: "#2b2100"
  primary-hover: "#ffd36b"
  focus: "#8cc8ff"
  link: "#5aa9ff"             # links, selection, the active tab
  sky: "#36b6ee"              # eyebrows, Parley's name
  navy: "#1a4fb5"             # the owl's waistcoat, the seller's chat bubbles
  ink: "#eef3fb"
  ink-muted: "#c5d0e3"
  ink-subtle: "#8fa0bc"
  canvas: "#0a1222"
  surface-1: "#0f1a2f"
  surface-2: "#15223c"
  surface-3: "#1b2b4a"
  hairline: "#1e2c47"
  hairline-strong: "#2c3e60"
  semantic-success: "#5fcf8f"   # fight, won, on file
  semantic-success-bg: "#10291f"
  semantic-warning: "#f0b04b"   # due soon
  semantic-warning-bg: "#2c2410"
  semantic-danger: "#f38375"    # refund, urgent, missing
  semantic-danger-bg: "#331a1c"

typography:
  display-xl: { fontFamily: Inter, fontSize: 68px, fontWeight: 600, lineHeight: 1.04, letterSpacing: -0.035em }
  display-md: { fontFamily: Inter, fontSize: 40px, fontWeight: 600, lineHeight: 1.12, letterSpacing: -0.03em }
  headline:   { fontFamily: Inter, fontSize: 28px, fontWeight: 600, lineHeight: 1.20, letterSpacing: -0.025em }
  card-title: { fontFamily: Inter, fontSize: 22px, fontWeight: 600, lineHeight: 1.25, letterSpacing: -0.02em }
  body-lg:    { fontFamily: Inter, fontSize: 18px, fontWeight: 400, lineHeight: 1.55 }
  body:       { fontFamily: Inter, fontSize: 16px, fontWeight: 400, lineHeight: 1.50 }   # landing
  body-sm:    { fontFamily: Inter, fontSize: 14px, fontWeight: 400, lineHeight: 1.50 }   # console default
  caption:    { fontFamily: Inter, fontSize: 12px, fontWeight: 400, lineHeight: 1.40 }
  button:     { fontFamily: Inter, fontSize: 14px, fontWeight: 500, lineHeight: 1.20 }   # 600 on the gold button
  eyebrow:    { fontFamily: Inter, fontSize: 12px, fontWeight: 500, lineHeight: 1.30, letterSpacing: 0.04em, textTransform: uppercase }
  mono:       { fontFamily: IBM Plex Mono, fontSize: 13px, fontWeight: 400, lineHeight: 1.50 }
  wordmark:   { fontFamily: Lilita One, fontSize: 24px, fontWeight: 400 }

rounded: { xs: 4px, sm: 6px, md: 8px, lg: 12px, xl: 16px, pill: 9999px }
spacing: { xxs: 4px, xs: 8px, sm: 12px, md: 16px, lg: 24px, xl: 32px, xxl: 48px, section: 96px }

components:
  button-primary:   { backgroundColor: "{colors.primary}", textColor: "{colors.on-primary}", rounded: "{rounded.md}", padding: 8px 14px }
  button-secondary: { backgroundColor: "{colors.surface-2}", textColor: "{colors.ink}", border: "1px {colors.hairline-strong}", rounded: "{rounded.md}", padding: 8px 14px }
  button-quiet:     { backgroundColor: transparent, textColor: "{colors.ink-subtle}", rounded: "{rounded.md}", padding: 8px 14px }
  chip:             { backgroundColor: "{colors.surface-1}", textColor: "{colors.ink}", border: "1px {colors.hairline}", rounded: "{rounded.md}", padding: 6px 12px }
  status-badge:     { rounded: "{rounded.pill}", padding: 1px 8px, typography: "600 11px, uppercase for a call" }
  card:             { backgroundColor: "{colors.surface-1}", border: "1px {colors.hairline}", rounded: "{rounded.lg}", padding: 16px }
  verdict-card:     { backgroundColor: "{colors.surface-2} with a 9% gold wash", border: "1px gold at 38%", rounded: "{rounded.lg}", padding: 16px }
  text-input:       { backgroundColor: "{colors.canvas}", border: "1px {colors.hairline-strong}", rounded: "{rounded.md}", padding: 8px 12px }
  top-nav:          { backgroundColor: "{colors.canvas} at 85% with blur", height: 56px }
---

# Parley design system

Where the tokens live: `desk/web/app.css` (`:root`, console) and the `<style>` of `desk/web/public/welcome.html`
(landing). Both carry the same values under the names `--bg`, `--card`, `--surface-2`, `--surface-3`, `--line`,
`--line-strong`, `--ink`, `--ink-2`, `--muted`, `--blue`, `--sky`, `--gold`, `--good`, `--warn`, `--bad`, `--r-*`.

## Overview

Parley is a calm money tool with one whimsical element: the owl. The chrome is quiet so that the owl, the gold
action and the status colours are the only things that speak.

- **Dark navy canvas.** `{colors.canvas}` is the page; it is the identity, on the landing page and in the console.
  A light set exists in `app.css` under `:root[data-theme="light"]` as an opt-in; nothing switches to it by itself.
- **Surface ladder, not shadows.** canvas → surface-1 (panels, cards) → surface-2 (nested tiles, hover, selected
  row, the verdict) → surface-3 (pressed, menus). Each lift has a 1px hairline. Shadows only under floating sheets
  (the phone chat sheet, the hero's product card).
- **Gold is scarce.** One gold button per view: the action Parley recommends, or the page's main call to action.
  Gold also marks "needs your OK" borders and an offer. It is never a section background.
- **Status colours carry meaning only.** Green = fight / won / on file. Red = refund / urgent / missing.
  Amber = due soon. They appear as text on a dark tint of themselves, never as large fills.
- **One voice of type.** Inter from display to body; weight 600 with negative tracking for display, 400 for body,
  500 for controls. Eyebrows are 12px, uppercase, +0.04em. Mono only for ids, API calls and the math.
- **The wordmark is the only cartoon type.** Lilita One is used for the word "Parley" in the top bar and nowhere else.

## Layout

- 4px base unit; gaps between cards 16px, inside cards 12–16px; landing sections 96px apart (64px on phones).
- Container 1280px (console), 1160px (landing). Top bar 56px, sticky, blurred canvas with a hairline under it.
- **Console, desktop:** tiles (4 across) → deadline strip → two columns: the dispute list (384px, sticky, scrolls
  in its own box) and the open case. From 1280px a 232px right gutter belongs to the owl; with the chat open the
  gutter is 396px.
- **Console, phone (≤ 860px):** the list comes first. Opening a dispute replaces the page with the case as a
  full-width view with a "← All disputes" button. Tabs scroll sideways. Parley is a dock across the bottom and the
  page reserves its height (`--dock`); the chat is a sheet above the dock. Nothing scrolls the page sideways:
  wide things (the grid, the math, the strip) scroll inside their own box.
- **Landing:** sticky nav with the gold "Open the console"; hero (headline left, owl and a small product card
  right); API strip; six use-case rows that alternate sides; "How it decides" (three step cards and one example
  panel); the demo notes as one banner card; footer.

## Components

- **Buttons:** 8px corners, 36px high (44px for the main action on phones and on the landing page). Primary = gold
  with dark text. Secondary = surface-2 with a strong hairline. Quiet = text only. Never pill-shaped, no offset
  shadows.
- **Chips** (`.chip`): small secondary buttons for page-level actions (Developers, Export CSV).
- **Badges** (`.call`, `.pill`, `.due`): pills, 11–12px, 600; a call is uppercase.
- **Cards** (`.card`, `.panel`, `.tile`, `.strip`): surface-1, hairline, 12px corners. Nested tiles (`.reason`,
  checklist rows) use 8px corners.
- **Verdict card:** the one lifted card on the page: surface-2 with a faint gold wash and a gold-tinted border.
- **"Needs your OK" cards** (`.confirm`, `.pc-card`): gold-tinted border, the exact PayPal call in mono, one gold
  button.
- **Tabs:** text tabs with a 2px blue underline for the selected one; they scroll sideways when they do not fit.
- **Tables:** AG Grid takes its colours from the same tokens (the `--ag-*` variables on `.grid` in `app.css`).
- **Inputs:** canvas background, strong hairline, 8px corners; focus is a 2px `{colors.focus}` ring.
- **Illustration placeholders** (`.art`): a surface-1 tile, 16px corners, with a dashed inner frame and a pose
  description, until the finished art replaces them.
- **The owl:** mounted by `owl.js` into `#owl`; this system only sizes and places its container.

## Motion

120ms colour transitions on controls. Landing sections ease in once as they scroll into view. The owl has its own
animations. `prefers-reduced-motion: reduce` turns all of these off.

## Accessibility

- Text is at least 4.5:1 on its surface (`{colors.ink-subtle}` on surface-1 is 6.5:1).
- Every focusable element shows a 2px `{colors.focus}` ring.
- Touch targets are at least 36px, 44px for primary actions on phones.
- Colour never carries a call alone: each status colour comes with its word (Fight, Refund, Offer $X).

## Do / Don't

- Do keep one gold button per view. Don't use gold for decoration.
- Do lift with the surface ladder and hairlines. Don't add drop shadows or thick outlines to cards and buttons.
- Do set money in tabular figures. Don't put mono on marketing text.
- Don't add a second accent colour, a second display face, or pill-shaped buttons.
