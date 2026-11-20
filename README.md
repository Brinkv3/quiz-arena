# Quiz Arena

A live, Kahoot-style quiz for up to sixty players. The host puts the question on a
big screen, everyone else answers on a phone or laptop, and the fastest correct
answer scores the most.

No framework, no build step, one dev dependency. The server is a single file and
so is the client. It runs on Cloudflare's free tier, and there is no container to
start or stop: a game room is created by the first request that mentions its PIN,
and it goes away on its own afterwards.

---

## Deploy it

You need a free Cloudflare account. Nothing else, and no domain.

```bash
npm install
npx wrangler login     # opens a browser once
npm run deploy
```

That prints your URL, something like
`https://quiz-arena.<your-subdomain>.workers.dev`. You pick the subdomain the
first time you deploy anything, and it applies to your whole account, so choose
one you can live with.

That URL is the whole thing. Anyone you send it to can host a game or join one.
They need no account, no install, and no copy of this repo.

To redeploy after a change, run `npm run deploy` again.

### Running your own copy

If someone wants their own instance with their own URL and quiz packs, they fork
this repo and run the three commands above against their own Cloudflare account.
There is also a one-click path:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Brinkv3/quiz-arena)

The button clones the repo into their GitHub account and deploys it. It is
convenient but occasionally flaky, so the three commands are the reliable path.

---

## Run it locally

```bash
npm install
npm run dev
```

`wrangler dev` boots the real Workers runtime on your machine, Durable Objects
and WebSockets included, so this is the same code path that runs in production.
Open the printed URL twice: host in one window, player in the other.

To test from a phone on the same wifi, run `npx wrangler dev --ip 0.0.0.0` and
visit your laptop's LAN address from the phone.

## Run the tests

```bash
npm test
```

Twenty-three tests over the room state machine: scoring and its speed curve,
answer guards, early close, reveal tallies, final ordering, reconnect payloads,
rate limiting, and the self-destruct alarm. Plain `node --test`, no test
framework.

---

## How a game runs

1. The host picks a quiz pack and presses **Start**. A six digit PIN appears.
2. Players open the same URL, enter the PIN and a nickname. The join link
   prefills the PIN for them.
3. The host presses **Start** again to send up question one.
4. A question closes when the clock runs out or everyone has answered.
5. Correct answers score 500 to 1000 points, scaled by how fast they arrived.
6. After the last question: a podium and the full standings.

From the podium the host can start another round with the same players. Scores
reset and a fresh set of questions is drawn, with no new PIN to share.

Players can only join before question one. A room deletes itself after six idle
hours, so PINs recycle.

The podium throws confetti, drawn on a canvas and skipped entirely when the
browser asks for reduced motion.

There is no sound. A generated audio bed was built and then removed: it is kept
in `parked/sound-engine.js` with notes on how to wire it back in.

## Solo play

A third option on the front page: pick a pack and play alone, questions and
answers on the same screen. It runs entirely in the browser — no room, no PIN,
no socket, nothing against the Worker quota — so it starts instantly and works
offline once the page is loaded.

Answering reveals the correct option immediately, with a running score, correct
count, and a streak counter that appears at two in a row. The end screen shows
accuracy and best streak, and keeps a personal best per pack in the browser's
local storage. Storage is best effort: in a private window or with site data
blocked, the game plays identically and simply does not remember the score.

The shuffle and draw in the client mirror `dealRound()` in the Worker. That is
two copies of about fifteen lines, kept deliberately: making a single player pay
for a server round trip they do not need would be the worse trade. One
consequence worth knowing — solo scores are computed in the browser and are
therefore trivially forgeable. That is fine for a personal best. Any public
leaderboard would need solo to run as a one-player server room instead.

## Getting out

The logo in the header is the way back. It is inert on the front page and turns
into a live control once you are in the editor or a game: back to the start from
the editor, leave the game as a player, end the game as a host. Anything with
consequences asks first.

This matters most when the site has been added to a phone's home screen, since a
standalone window has no browser back button. Players can also leave from the
buttons on the result and final screens.

## Quiz packs

Ten packs ship with the game: Richmond, AI, AI governance, video games, history,
movies, music, science fiction, sports, and Taylor Swift.

A pack is a JSON file in `public/quizzes`:

```json
{
  "title": "Richmond, Start to Finish",
  "slug": "rva",
  "draw": 10,
  "questions": [
    {
      "q": "Which river runs through downtown?",
      "a": ["Rappahannock", "James", "Potomac", "Shenandoah"],
      "correct": 1,
      "seconds": 15
    }
  ]
}
```

`correct` is a zero-based index. Two to four answers per question, 5 to 120
seconds each.

`draw` is optional. When set, each game serves that many questions taken at
random from the pack rather than all of them, so a pack of 24 with a draw of 10
plays differently every time. Leave it out and every question is used.

Question order and answer order are both shuffled for every game, so even a pack
that serves all its questions does not repeat itself.

To add a pack permanently: drop the file in `public/quizzes`, add a line to
`manifest.json`, redeploy. It appears in the host's dropdown.

The built-in editor writes this exact format, so a quiz built in the browser
downloads as a valid pack with no conversion. `?quiz=rva` deep links to a pack,
which means a link can be a game.

---

## What it costs

The free plan gives 100,000 Durable Object requests a day, and WebSocket messages
bill at twenty to one, so a hundred messages count as five requests. A forty
player game across twenty questions is a few thousand messages. Idle rooms
hibernate and are not billed for duration.

`/api/new` is capped at twenty new games per hour per IP, which leaves normal
hosting untouched while making it pointless to script room creation against your
quota.

## Layout

```
src/index.js              Worker: PIN minting, rate limit, WebSocket routing, GameRoom
public/index.html         host screen, player screen, quiz editor
public/quizzes/           quiz packs plus manifest.json
test/room.test.js         state machine tests
parked/sound-engine.js    generated audio, removed but kept for later
wrangler.jsonc            bindings and the SQLite Durable Object migration
```

## Notes

No API keys or secrets, so the repo is safe to make public.

No web fonts and no CDN. Type is a system stack, so the page renders the same
offline, on a locked-down network, or with the network partly broken.

## Security posture

No API keys or secrets, so the repo is safe to make public. Zero runtime
dependencies: the only package is `wrangler`, and it never ships to production.

**Authority.** The host holds a random 128 bit key returned when the room is
created. Knowing a PIN lets you join and answer; it does not let you start
questions, load a quiz, advance, or trigger a rematch. Every host command checks
the socket's role, so a player who crafts one gets ignored.

**Input.** Nicknames are stripped of control characters, bidi overrides, and
zero-width joiners, then capped at sixteen. Quiz titles, questions, and answers
are truncated rather than rejected, and question length is clamped to 5 to 120
seconds. Anything that parses as JSON but is not a plain object is discarded
before it is read, so a bare `null` cannot take a room down. Answer choices must
be integers inside the current question's range.

**Rendering.** The client never assigns user-controlled data to `innerHTML`. All
text goes through `textContent`, so a nickname containing markup displays as
literal text. There is no `eval`, no `new Function`, and no remote script.

**Limits.** Twenty room creations per hour per IP. Sixty players per room. One
answer per player per question, and a nickname already connected cannot be taken
by someone else. Every rejection is decided before a socket is allocated, so a
refused request costs nothing. Rooms delete themselves after six idle hours.

**Known and accepted.** PINs are six digits, so with many rooms live at once a
determined guesser could stumble into one; the blast radius is joining a trivia
game. Joining is not rate limited. Anyone with the URL can host, which is the
intended behavior rather than an oversight.
