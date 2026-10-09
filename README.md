# Anifighters live PvP + co-op + friends server

This small server runs live PvP matches, live co-op battles and the in-game Friends list (online status, friend requests and chat).

It runs two kinds of live matches between real players:

- **Classic PvP:** a friendly match. Players at a similar team level are paired first. Anyone waiting more than 15 seconds gets matched with the next player.
- **Ranked:** players are paired by rank points (everyone starts at 1000). The allowed gap starts at 150 points and widens every 10 seconds. After 45 seconds you can be matched with anyone.

Both are real-time team duels. Each player brings their 3-fighter team, and each player's moves are sent to the other player's phone as they happen. A duel lasts 3 minutes. You win by knocking out the other team. If time runs out, the player with more team HP left wins. Equal HP is a draw. If a player leaves, the other player wins.

## Co-op

Two players team up against one boss. Each player picks a co-op mission (10 missions) or a boss raid (4 raids), and the server pairs two players who picked the same one.

- The server holds the boss HP. Each player's damage is sent to the server, which takes it off the shared boss HP and tells both players.
- The server runs the boss. Every few seconds it picks a target and an attack. It usually switches to the other player, so the boss fights both of you. At 70% and 35% boss HP it uses its ultimate.
- Each player's moves and HP are sent to the partner, so both phones show both fighters side by side.
- If one player's team is knocked out, the partner keeps fighting. Both teams down, or time running out, is a loss. Taking the boss to 0 HP is a win for both players.
- If a partner leaves, the other player fights on alone.

There are no dependencies. It needs Node.js 18 or newer.

## Run it on your own computer (testing)

    node server.js

It listens on port 8787. Open http://localhost:8787/health to check. For quick tests use a shorter duel: `DUEL_MS=40000 node server.js`.

## Put it online (free hosting, for example Render)

1. Upload `server.js` and `package.json` to a GitHub repository (replace the old files if you already have one).
2. On render.com create a **Web Service** from that repository. Start command: `npm start`. Render sets `PORT` for you.
3. Check `https://YOUR-ADDRESS/health`. You should see `{"ok":true,...}`.
4. Render redeploys by itself each time you change the files in the repository.

The game needs your server address. It is set in the PWA's `index.html`:

    <script>window.ANI_PVP_SERVER='https://YOUR-ADDRESS';</script>

Free servers sleep when idle. The game shows a "Connecting" screen while it waits for the server to wake up (up to about a minute).

## What the server checks

- **Usernames:** 3-14 letters, numbers, spaces, underscores or dashes. Names with blocked words (list `BAD` at the top of `server.js`), or names that are too short, become `PLAYER` plus a random code.
- **Attacks:** one attack can never deal more than 6 times the sender's highest attack stat, and attacks are limited to about 2 per second.
- **HP:** a player's HP can only go down. It can never go up or exceed its starting value.

## Friends list

- **Online status:** while a player has the game open, it keeps a connection to `/social`. Friends see them as ONLINE; when they close the game they show as OFFLINE with how long ago they left.
- **Search:** `/search?q=NAME` finds players by username (at least 2 letters). It finds players who have opened the game since the server last started.
- **Requests:** sending, accepting, declining and removing friends go through `/friend`.
- **Chat:** `/chat` only delivers messages between friends. Messages are cut to 160 characters, blocked words are starred out, and each player can send about one message a second.
- **Offline delivery:** requests and messages for an offline player wait in their inbox (up to 60) and arrive when they next open the game, as long as the server has not restarted.
- Each player gets a random id and secret key the first time they open the game, so nobody can send messages pretending to be them.

## Known limits

- Each phone works out its own damage and reports it. The server limits it as described above, but a determined cheater could still bend the numbers. Real anti-cheat would mean running the whole fight on the server.
- Friends lists and chat history are saved on each player's phone. The server only keeps things in memory, so if a free server sleeps or restarts, waiting requests and messages for offline players are lost and search only finds players who have connected since. A database would fix this.
- Ranked points are saved on the player's phone, not on the server. Clearing site data resets them. Saving ranks on the server would need an accounts database.
- Players have no accounts. The player ID is saved in the browser.
- The server keeps matches in memory. A restart ends any duel in progress and empties the queues.

## Endpoints

- `GET /events?id=ID` opens the live stream (events: match, msg, end).
- `POST /queue` with `{ id, name, level, rating, mode }` joins matchmaking. `mode` is `classic`, `ranked` or `coop`. Co-op also sends `mission` (`c1`-`c10` or `r1`-`r4`), `time` and `tempo`.
- `POST /send` with `{ id, matchId, msg }` sends a move to the rival (team, act, st, lost). Co-op also uses `dmg` (damage to the boss).
- `POST /leave` with `{ id }` leaves the queue or forfeits a match.
- `GET /health` returns server status.
