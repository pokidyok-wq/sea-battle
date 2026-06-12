# 🚢 Sea Battle

Online 2-player Battleship. Pure static frontend (HTML + canvas + vanilla JS),
state synced through [Supabase](https://supabase.com) Realtime. No build step,
no accounts — one player shares a 4-letter room code, the other joins.

## Play

1. Player A clicks **New Game** → gets a room code (e.g. `KQTP`).
2. Player A shares the code with Player B.
3. Player B types the code and clicks **Join**.
4. Both place their fleet (click to drop, **R** to rotate, or **Randomize**) and hit **Ready**.
5. Take turns firing at enemy waters. A hit lets you fire again; a miss passes the turn. Sink the whole fleet to win.

Fleet: 10×10 board — 1×4-square, 2×3-square, 3×2-square, 4×1-square (10 ships, 20 squares).

## One-time setup

### 1. Database (Supabase)

Open your project → **SQL Editor** → New query → paste [`schema.sql`](schema.sql) → **Run**.
That creates the `games` table, opens permissive RLS for the anon key, and turns on Realtime.

### 2. Config

[`config.js`](config.js) holds the Supabase **project URL** and **anon public key**.
The anon key is safe to ship in the browser — protection comes from Row-Level
Security, not from hiding the key. (Never put the database password or the
`service_role` key here.)

## Hosting (GitHub Pages)

These are plain static files, so just push to the repo and enable Pages:

```sh
git init
git add .
git commit -m "Sea Battle game"
git branch -M main
git remote add origin https://github.com/pokidyok-wq/sea-battle.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: `main` / root**. Your game goes
live at `https://pokidyok-wq.github.io/sea-battle/`.

## Local dev

Because the page loads `config.js` and the Supabase SDK from a CDN, just open
`index.html` — or serve it for a cleaner origin:

```sh
python -m http.server 8000
# then visit http://localhost:8000
```

Open it in two browser tabs (or two devices) to play both sides.

## Notes / limits

- **Minimal anti-cheat:** the full game state (including both boards) lives in
  one shared row, so a determined player could read the opponent's layout via
  the API. Fine for friendly games; tighten with server-side logic later.
- **Two players per room.** A third person using the code is rejected.
