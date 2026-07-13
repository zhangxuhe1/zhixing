# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** 知行
**Generated:** 2026-07-13 14:39:44
**Category:** Cultural travel map / editorial storytelling

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#153F36` | `--color-primary` |
| Secondary | `#376D61` | `--color-secondary` |
| CTA/Accent | `#B8402E` | `--color-cta` |
| Background | `#F5F0E3` | `--color-background` |
| Text | `#171F1C` | `--color-text` |

**Color Notes:** 宣纸米白 + 松墨绿 + 朱砂点色 + 少量石青/旧金；以自然材质感替代泛 SaaS 高饱和色。

### Typography

- **Heading Font:** Songti SC / system serif
- **Body Font:** SF Pro / PingFang SC
- **Mood:** calm, tactile, contemporary Chinese, editorial, trustworthy

**SwiftUI implementation:** `.system(..., design: .serif)` for editorial titles; system body typography for legibility and Dynamic Type.

### Spacing Variables

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` / `0.25rem` | Tight gaps |
| `--space-sm` | `8px` / `0.5rem` | Icon gaps, inline spacing |
| `--space-md` | `16px` / `1rem` | Standard padding |
| `--space-lg` | `24px` / `1.5rem` | Section padding |
| `--space-xl` | `32px` / `2rem` | Large gaps |
| `--space-2xl` | `48px` / `3rem` | Section margins |
| `--space-3xl` | `64px` / `4rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

### Buttons

```css
/* Primary Button */
.btn-primary {
  background: #153F36;
  color: white;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
  opacity: 0.88;
}

/* Secondary Button */
.btn-secondary {
  background: transparent;
  color: #153F36;
  border: 1px solid rgba(21, 63, 54, 0.24);
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}
```

### Cards

```css
.card {
  background: #FFFCF5;
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--shadow-md);
  transition: all 200ms ease;
  cursor: pointer;
}

.card:hover {
  box-shadow: var(--shadow-lg);
  border-color: rgba(21, 63, 54, 0.18);
}
```

### Inputs

```css
.input {
  padding: 12px 16px;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  font-size: 16px;
  transition: border-color 200ms ease;
}

.input:focus {
  border-color: #153F36;
  outline: none;
  box-shadow: 0 0 0 3px #153F3620;
}
```

### Modals

```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal {
  background: white;
  border-radius: 16px;
  padding: 32px;
  box-shadow: var(--shadow-xl);
  max-width: 500px;
  width: 90%;
}
```

---

## Style Guidelines

**Style:** Contemporary Chinese editorial + restrained material glass

**Keywords:** rice-paper texture, topographic lines, mineral pigments, restrained glass, generous reading rhythm

**Best For:** Map-first cultural travel, long-form local stories, personal memory collections, Mac/iOS shared interfaces

**Key Effects:** Material surfaces above maps, 150–250ms state transitions, soft elevation, no decorative continuous motion

### Page Pattern

**Pattern Name:** Scroll-Triggered Storytelling

- **Conversion Strategy:** Narrative increases time-on-page 3x. Use progress indicator. Mobile: simplify animations.
- **CTA Placement:** End of each chapter (mini) + Final climax CTA
- **Section Order:** 1. Intro hook, 2. Chapter 1 (problem), 3. Chapter 2 (journey), 4. Chapter 3 (solution), 5. Climax CTA

---

## Anti-Patterns (Do NOT Use)

- ❌ Cheap visuals
- ❌ Fast animations

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
