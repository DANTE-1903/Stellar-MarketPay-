# Accessibility at Stellar MarketPay

## Summary

This document describes the accessibility (a11y) posture, standards, testing tools, and component guidelines for the Stellar MarketPay project. The project aims for **WCAG 2.1 Level AA** compliance across the web application.

---

## Standards & Compliance Goals

Stellar MarketPay follows the Web Content Accessibility Guidelines (WCAG) 2.1 Level AA. Key areas of focus include:

1. **Color Contrast (WCAG 1.4.3 & 1.4.11)**
   - Normal text (< 18pt or < 14pt bold): minimum 4.5:1 contrast ratio.
   - Large text (≥ 18pt or ≥ 14pt bold): minimum 3.0:1 contrast ratio.
   - UI components and graphical objects: minimum 3.0:1 contrast ratio.
2. **Keyboard Navigation (WCAG 2.1.1 & 2.1.2)**
   - All interactive controls are navigable and operable using a keyboard.
   - Modals and dialogs trap focus while open and return focus to triggering elements upon dismissal.
   - No keyboard traps.
   - Keyboard shortcuts (`Shift + T` for theme toggling, `Esc` for closing modals).
3. **Focus Visibility (WCAG 2.4.7)**
   - Clear, high-visibility focus indicators (`focus-visible:ring-2 focus-visible:ring-market-400` or theme-specific rings).
4. **Accessible Rich Internet Applications (ARIA)**
   - Proper use of semantic HTML5 landmark tags (`<main>`, `<nav>`, `<aside>`, `<header>`, `<footer>`).
   - Modal dialogs with explicit `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, and `aria-describedby`.
   - Descriptive accessible names on icon buttons and action triggers.
5. **Theme Support & High Contrast**
   - Light, Dark, and High Contrast mode support.
   - Windows High Contrast Mode (`forced-colors` media query support and system color keywords).

---

## Component Architecture & Accessible Modal

The application includes an accessible modal component pattern (`frontend/components/AccessibleModal.tsx`) and accessible modal implementations:

- **Accessible Dialog Container**: Uses `role="dialog"` and `aria-modal="true"`.
- **Focus Management**:
  - Automatically captures and moves focus to the first interactive element or the panel upon mounting.
  - Traps keyboard `Tab` / `Shift+Tab` cycling inside the dialog while open.
  - Automatically restores focus to the previously focused element upon dismissal.
- **Escape Key Handling**: Listens for the `Escape` key globally to dismiss the modal cleanly.
- **Accessible Labelling**: Requires `titleId` / `labelledBy` linked to the modal title, and `description` for screen reader announcements (`aria-describedby`).

Components implementing accessible modal patterns include:
- `AccessibleModal.tsx`
- `ShareJobModal.tsx`
- `KeyboardShortcutsModal.tsx`
- `FeeEstimationModal.tsx`
- `WithdrawToBankModal.tsx`
- `BuyXLMModal.tsx`
- `CommandPalette.tsx`
- `OnboardingWizard.tsx` / `WelcomeModal.tsx`

---

## Testing Tools & Procedures

We use automated and manual tools to maintain and verify accessibility standards:

### 1. Axe-core Playwright E2E Specs

Automated accessibility audits run via `@axe-core/playwright` across application pages, asserting zero `critical` or `serious` violations for WCAG 2.0 / 2.1 Level A and AA rules.

- **File**: `frontend/tests/e2e/accessibility.spec.ts`
- **How to run**:
  ```bash
  cd frontend
  npm run test:a11y
  # or via playwright directly:
  npx playwright test tests/e2e/accessibility.spec.ts
  ```

### 2. Color Contrast Auditor

A dedicated contrast audit script verifies contrast ratios for all theme palettes (Light, Dark, High Contrast) across text, muted text, subtle text, and accent colors.

- **File**: `frontend/scripts/audit-contrast.mjs`
- **How to run**:
  ```bash
  cd frontend
  npm run audit:contrast
  # or directly with Node:
  node scripts/audit-contrast.mjs
  ```

### 3. Continuous Integration

Accessibility checks are integrated into CI workflows (`.github/workflows/accessibility.yml`), executing automated scans on pull requests touching frontend components or styles.

---

## Developer Guidelines

When adding or updating UI components:

1. **Semantic Elements**: Always prefer native HTML elements (`<button>`, `<a>`, `<input>`, `<dialog>`) over generic `<div>` with click handlers.
2. **Accessible Names**: Every button, link, and form input must have a discernible name (`aria-label`, visible text, or associated `<label>`).
3. **Contrast Verification**: Run `npm run audit:contrast` whenever modifying palette colors or Tailwind color configurations.
4. **Keyboard Testing**: Test all interactions using only the keyboard (`Tab`, `Shift + Tab`, `Enter`, `Space`, `Escape`).
5. **Run A11y Suite**: Run `npm run test:a11y` before opening a pull request.
