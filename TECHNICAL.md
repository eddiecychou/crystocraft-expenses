# Expense Organiser — Technical Documentation

## Overview

Expense Organiser is a multi-user web application for capturing, categorising, and exporting business receipts. Users upload receipt images or PDFs, which are scanned by AI to extract key fields (date, vendor, amount, currency, category). Expenses are organised into projects (e.g. one per company), stored in Firestore, and can be exported to Excel or a ZIP of receipt images.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, React Router v6, Vite + SWC |
| Auth | Firebase Authentication (email/password + Google OAuth) |
| Database | Cloud Firestore |
| File Storage | Firebase Storage |
| Serverless Functions | Netlify Edge Functions (Deno runtime) + Netlify Functions (Node.js) |
| AI | Google Gemini API (`gemini-2.5-flash`, `gemini-2.5-pro` fallback) |
| Export | ExcelJS (`.xlsx`), JSZip (`.zip`) |
| Hosting | Netlify |

---

## Architecture

```
Browser (React SPA)
│
├── Firebase Auth          — sign-in / sign-out / session state
├── Firestore              — projects and expenses data
├── Firebase Storage       — receipt images and PDFs
│
└── Netlify (edge/serverless)
    ├── /api/process-receipt   — Edge Function (Deno): calls Gemini AI to extract receipt data
    ├── /api/download-receipt  — Edge Function (Deno): CORS proxy for downloading storage images
    └── /.netlify/functions/export-excel  — Node Function: (legacy path, kept for routing)
```

The frontend is a pure SPA deployed to Netlify. All API calls stay within the same origin, avoiding CORS issues. Sensitive keys (Firebase config, Gemini API key) are stored as Netlify environment variables and never exposed to the browser.

---

## Project Structure

```
/
├── index.html
├── vite.config.js
├── netlify.toml
├── package.json
│
├── src/
│   ├── main.jsx                  — app entry point
│   ├── App.jsx                   — router, auth guard, ProjectProvider wrapper
│   ├── App.css                   — all styles (single file)
│   ├── firebase.js               — Firebase app init with IndexedDB persistence (auth, db, storage exports)
│   ├── constants.js              — CATEGORIES and CURRENCIES arrays
│   │
│   ├── hooks/
│   │   └── useAuthState.js       — wraps onAuthStateChanged as a React hook
│   │
│   ├── contexts/
│   │   └── ProjectContext.jsx    — project list, active project, color themes
│   │
│   ├── components/
│   │   ├── Layout.jsx            — sidebar nav, logout, CSS variable injection
│   │   ├── ProjectBanner.jsx     — active project name/dot shown on each page
│   │   ├── ConfirmDialog.jsx     — in-app confirmation modal (replaces browser confirm())
│   │   └── LoadingBar.jsx        — animated progress bar shown during all loading states
│   │
│   └── pages/
│       ├── Login.jsx             — sign in / sign up / forgot password
│       ├── Dashboard.jsx         — summary stats and expense list with date filters
│       ├── Upload.jsx            — receipt upload, AI extraction, save flow
│       ├── Expenses.jsx          — full records table, edit, delete, export
│       └── Settings.jsx          — project management (create, rename, recolor, delete)
│
└── netlify/
    ├── edge-functions/
    │   ├── process-receipt.js    — Gemini AI receipt parser (Deno)
    │   └── download-receipt.js   — CORS proxy for Firebase Storage URLs (Deno)
    └── functions/
        ├── export-excel.js       — (legacy) Node.js function
        └── package.json
```

---

## Firebase Setup

### Services Used

| Service | Purpose |
|---|---|
| Authentication | User sign-in (email + Google) |
| Firestore | `projects` and `expenses` collections |
| Storage | Receipt images at `receipts/{uid}/{expenseId}/image{n}.{ext}` |

### Firestore Collections

**`projects`**
```
{
  userId: string,       // Firebase Auth UID
  name: string,
  color: string,        // one of 10 color keys (see ProjectContext)
  createdAt: Timestamp
}
```

**`expenses`**
```
{
  userId: string,
  userEmail: string,
  projectId: string,
  date: string,         // YYYY-MM-DD
  vendor: string,
  amount: number,
  currency: string,     // HKD | RMB | USD | EUR | JPY | AUD | GBP | SGD | CAD | KRW | Other
  category: string,     // Travel | Meals | Office | Software | Utilities | Development |
                        // Marketing | Professional Services | Equipment | Bank Charges | Other
  notes: string,
  images: [{ url: string, path: string, name: string }],
  createdAt: Timestamp
}
```

### Security Rules

Firestore rules should restrict read/write to `userId == request.auth.uid`. Storage rules should restrict access to `receipts/{userId}/**` paths matching the authenticated user.

### Required Firestore Indexes

No composite indexes are required. All queries use `where('userId', '==', uid)` which is automatically indexed. Project filtering is done client-side.

### Authorized Domains

Add all deployment domains to Firebase → Authentication → Settings → Authorized domains:
- `localhost`
- `ua-expense-tool.netlify.app` (production)
- Any Netlify branch preview domains (e.g. `feature-*--ua-expense-tool.netlify.app`)

---

## Environment Variables

### Frontend (`.env.local` / Netlify site variables)

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

These are bundled into the client at build time (Vite `import.meta.env`). They are safe to expose — Firebase security is enforced by Auth rules, not key secrecy.

### Backend (Netlify environment variables — server only)

```
GEMINI_API_KEY=        — Google AI Studio API key
```

This key is only accessed inside the Deno edge function and is never sent to the browser.

---

## Key Features

### Authentication

- Email/password sign-up and sign-in via Firebase Auth
- Google OAuth via `signInWithPopup`
- Forgot password via `sendPasswordResetEmail`
- Session persisted automatically by Firebase SDK
- `useAuthState` hook wraps `onAuthStateChanged` and drives the `ProtectedRoute` guard

### Multi-Project Support

`ProjectContext` manages the project list and tracks the active project in `localStorage`. On first sign-in a `Default` project is auto-created. Any expenses without a `projectId` (migrated data) are treated as belonging to the Default project.

Project selection is instant — `selectProject` updates `localStorage` and React state without a network round-trip. Project edits use `updateProject` for immediate UI updates while persisting to Firestore in the background.

### Color Theming

Ten color themes are defined in `PROJECT_COLORS` (green, blue, amber, purple, slate, teal, rose, orange, indigo, brown). When a project is active, `Layout.jsx` injects four CSS custom properties on the `.app-layout` wrapper:

```jsx
style={{
  '--t-dark': c.dark,
  '--t-mid': c.mid,
  '--t-btn': c.btn,
  '--t-btn-hover': c.btnHover,
}}
```

All themed UI elements (sidebar, buttons, badges) reference these variables via `var(--t-btn)` etc. The `:root` block in `App.css` provides green fallback values for the login page, which sits outside `.app-layout`.

### Expense Categories

Eleven categories are defined in `constants.js` and used across dropdowns, badges, and the AI prompt:

| Category | Typical use |
|---|---|
| Travel | Flights, trains, taxis, hotels |
| Meals | Restaurants, cafes, food |
| Office | Stationery, supplies |
| Software | Apps, subscriptions, SaaS |
| Utilities | Electricity, internet, phone |
| Development | Coding tools, hosting, domains |
| Marketing | Ads, promotions, print materials |
| Professional Services | Accounting, legal, consulting fees |
| Equipment | Hardware, machinery, tools |
| Bank Charges | Transaction fees, wire transfers, FX fees |
| Other | Anything that doesn't fit above |

Badge CSS class names are generated by converting the category to lowercase with spaces replaced by hyphens (e.g. `badge-professional-services`).

### Receipt Upload & AI Extraction

1. User drops or selects image/PDF files (JPEG, PNG, WebP, HEIC, GIF, BMP, TIFF, PDF)
2. Images are resized client-side to max 2400px and compressed to JPEG 93% using `OffscreenCanvas`
3. Before sending to Gemini, `preprocessForGemini` creates a separate high-contrast version in memory:
   - Converts to greyscale (removes colour noise, improves thermal receipt contrast)
   - Applies auto-levels (stretches histogram to 0–255, clipping 1% outliers)
   - Encodes as lossless PNG
4. The preprocessed PNG is POSTed to `/api/process-receipt`; the original colour JPEG is kept for Firebase Storage
5. The Deno edge function forwards to Gemini with a structured JSON prompt
6. Extracted fields are returned and rendered in an editable form
7. User reviews/corrects fields, then saves — expense is written to Firestore and original colour JPEG uploaded to Firebase Storage

**Upload flow UX:**

1. User selects or drops files — the dropzone is hidden immediately so it cannot be accidentally re-tapped
2. **Single file:** AI extraction starts automatically — no button press required. **Multiple files:** a file list appears with individual Remove buttons so the user can review before pressing "Extract Data with AI"
3. Each file item carries a stable numeric `_id` (from a `fileIdRef` counter) so Remove works correctly even when multiple mobile photos share the same generic filename (`image.jpg`)
4. During extraction a sliding indeterminate progress bar appears below the button. For multi-file batches the button also shows a counter (`Extracting 2 of 5…`). The same bar appears during "+ Scan More" processing in the results view
5. Results cards appear for review; required fields (Date, Vendor, Amount) are highlighted in red if empty on save

**Mobile date input:** `input[type="date"]` in result cards has `-webkit-appearance: none` to normalise its width alongside other inputs, plus `min-height: 36px` and `line-height: 1.4` to prevent it collapsing to a thin strip when the value is empty (a WebKit bug with appearance reset on iOS).

**Two-image pipeline summary:**

| Version | Format | Used for |
|---|---|---|
| Colour JPEG (93%) | `image/jpeg` | Firebase Storage, receipt lightbox |
| Greyscale PNG (lossless) | `image/png` | Gemini API only, discarded after extraction |

**Gemini model fallback:** tries `gemini-2.5-flash` first, falls back to `gemini-2.5-pro`. On high-demand errors, retries once after 3 seconds.

**AI prompt design:** The prompt instructs Gemini to return only a JSON object with explicit rules for each field — amount is defined as the final total paid (not subtotal), currency detection covers 10 currencies with symbol mappings, and category rules give concrete examples for each option.

### Export

- **Excel (`.xlsx`)**: Built client-side with ExcelJS. Columns: Date, Vendor, Amount, Currency, Category, Notes, Receipts (image URLs). Includes per-currency totals row.
- **Receipt ZIP**: Images are downloaded via the `/api/download-receipt` CORS proxy (since Firebase Storage URLs require authenticated requests), then packed with JSZip. Files are organised as `YYYY-MM/Category/date_vendor_amount_currency.ext`. Downloads in batches of 6 with progress counter.

### Confirmation Dialogs

All destructive actions (delete expense, delete receipt image, delete project) use a custom `ConfirmDialog` React component instead of the browser's native `confirm()`. The native dialog shows a "Block this pop-up" option on mobile Chrome which is confusing. The in-app modal renders a message with **Cancel** and **Delete** buttons, tapping the overlay also cancels.

---

## Performance

### Firestore IndexedDB Persistence

Firestore is initialised with `persistentLocalCache` and `persistentMultipleTabManager` (Firebase v10 API):

```js
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
})
```

This writes every Firestore snapshot to the browser's IndexedDB. On subsequent page loads the data is served from the local cache immediately, with any server-side changes applied silently in the background. Without this, every refresh performs a full network round-trip regardless of caching headers.

### Real-time Listeners (`onSnapshot`)

All three Firestore queries — projects (in `ProjectContext`), expenses on Dashboard, and expenses on Expenses — use `onSnapshot` instead of `getDocs`. Combined with `persistentLocalCache`, the first `onSnapshot` callback fires instantly from IndexedDB on repeat loads.

`onSnapshot` also auto-pushes any document changes (edits, deletes, new images) back to the component state, so no manual reload calls are needed after mutations. Each listener is properly cleaned up via the `return unsubscribe` pattern inside `useEffect`.

**Dashboard date filters** are applied entirely in memory — changing the date range or preset does not trigger a new query. All expenses for the active project are stored in `allExpenses` state; the rendered `expenses` variable is a filtered derivation.

### Loading State Sequence

Every loading phase shows the same `LoadingBar` animated progress component — there is no plain "Loading…" text at any point:

1. **Auth initialisation** (`ProtectedRoute` in `App.jsx`) — while `useAuthState` resolves the Firebase Auth session from IndexedDB
2. **Project loading** (`ProjectContext`) — while the projects `onSnapshot` fires for the first time
3. **Expense loading** (Dashboard / Expenses) — while the expenses `onSnapshot` fires for the first time

On a warm cache (any refresh after the first load), steps 2 and 3 resolve in milliseconds from IndexedDB, making the visible loading time effectively just the auth initialisation step.

### Migration Guard

On first load `ProjectContext` runs `migrateExpenses` to backfill `projectId` on legacy expenses. This is guarded by a `localStorage` flag (`expenses_migrated_{uid}`) so the Firestore batch query only runs once per user per browser, not on every login.

---

## Netlify Configuration (`netlify.toml`)

```toml
[build]
  command = "npm run build"
  publish = "dist"

[build.environment]
  NODE_VERSION = "20"

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"

[[edge_functions]]
  function = "process-receipt"
  path = "/api/process-receipt"

[[edge_functions]]
  function = "download-receipt"
  path = "/api/download-receipt"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

The wildcard redirect at the bottom enables client-side routing (React Router) on direct URL loads and refreshes.

---

## Local Development

```bash
# Install dependencies
npm install

# Create .env.local with the six VITE_FIREBASE_* variables above
# The GEMINI_API_KEY is only needed for the edge function; set it in Netlify for production.

# Start dev server
npm run dev
```

The local dev server does not run Netlify edge functions. To test AI extraction locally, use the Netlify CLI:

```bash
npm install -g netlify-cli
netlify dev
```

Set `GEMINI_API_KEY` in a `.env` file or via `netlify env:import`. The CLI will inject it into the Deno edge function at runtime.

---

## Deployment

The app deploys automatically via Netlify's Git integration.

1. Push to `main` → triggers a production build → deploys to `https://ua-expense-tool.netlify.app`
2. Push to a feature branch → triggers a branch preview build (if branch deploys are enabled in Netlify settings) → deploys to `https://<branch-name>--ua-expense-tool.netlify.app`

When testing a new feature branch that uses Firebase Auth, add the branch preview URL to Firebase → Authentication → Authorized domains before testing Google sign-in.

---

## Data Migration

On first sign-in, `ProjectContext` runs `migrateExpenses` — an idempotent batch operation that sets `projectId` on any expenses saved before multi-project support was added. Expenses without a `projectId` are assigned to the user's Default project. After running, a `localStorage` flag (`expenses_migrated_{uid}`) prevents it from running again on subsequent logins.
