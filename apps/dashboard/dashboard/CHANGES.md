# UI redesign — what changed

Design: pill top-nav with sliding indicator, icon rail, soft cards, orange hero box,
black gradient box, stacked chart, blur-in / spring animations, light + dark theme
(circular reveal). No API or business logic was changed.

## New files
- `src/app/(app)/overview/page.tsx` — landing dashboard built from real API data
  (open/pending/closed counts, 7-day chart, team workload, recent audit activity)
- `src/components/pill-nav.tsx` — nav pill with spring-sliding active indicator
- `src/components/count-up.tsx` — eased count-up numbers

## Rewritten
- `src/app/globals.css` — full design system (also styles every class the pages
  already used but that had no CSS: inbox list, thread, contact panel, auth card…)
- `src/components/app-shell.tsx` — new shell: top nav, icon rail, theme switch,
  profile menu, search, page header, settings sub-nav, auth guard

## Edited
- `tokens.css` (dedup + warn tokens), `icons.tsx` (+Grid/Help/Sun/Moon),
  `layout.tsx` (Inter as CSS variable), `theme.ts` (smoother reveal),
  `page.tsx` / login / signup (land on /overview, logo mark)
- Every page: outer `<main>` → `<div className="page">` (the shell owns the single `<main>`)
- conversations index: inbox card + empty-thread placeholder
- widget settings: two-column layout + preview on the new design classes
- api-keys / members / security / visitors: inline styles replaced with design classes
