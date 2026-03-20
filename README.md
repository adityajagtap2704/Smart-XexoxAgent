# Smart Xerox – Full Stack App

> Converted from TypeScript/TSX (Lovable) → **React JS + Tailwind CSS**

## Project Structure

```
smart-xerox/
├── frontend/     ← React + Vite + Tailwind CSS (JavaScript)
└── backend/      ← Node.js + Express + MongoDB
```

---

## Frontend Setup

```bash
cd frontend
npm install
cp .env.example .env       # Fill in your API URL & Razorpay key
npm run dev                # Starts on http://localhost:3000
```

### Environment Variables (`.env`)
```
VITE_API_URL=http://localhost:5000/api
VITE_SOCKET_URL=http://localhost:5000
VITE_RAZORPAY_KEY=rzp_test_your_key_here
```

---

## Backend Setup

```bash
cd backend
npm install
cp .env.example .env       # Fill in MongoDB URI, JWT secret, etc.
npm start                  # Starts on http://localhost:5000
```

See `backend/.env.example` for all required environment variables (MongoDB, AWS S3, Razorpay, email config, etc.)

---

## What Changed (TSX → JSX)

- All `.tsx` files → `.jsx`, all `.ts` files → `.js`
- All TypeScript interfaces, types, and generics removed
- Removed: `bun.lock`, `tsconfig*.json`, `*.d.ts` files, test files (Playwright/Vitest), `lovable-tagger`
- `vite.config.ts` → `vite.config.js` using `@vitejs/plugin-react` (not swc-ts)
- `package.json` cleaned – only necessary dependencies kept
- All Tailwind classes and UI behaviour **100% identical** to the original
