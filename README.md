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

Players can only join before question one. A room deletes itself after six idle
hours, so PINs recycle.

## Getting out

The logo in the header is the way back. It is inert on the front page and turns
into a live control once you are in the editor or a game: back to the start from
the editor, leave the game as a player, end the game as a host. Anything with
consequences asks first.

This matters most when the site has been added to a phone's home screen, since a
standalone window has no browser back button. Players can also leave from the
buttons on the result and final screens.

## Sound

Off by default. The toggle appears in the header once you are in a game, and it
has to be pressed by hand because browsers block audio that starts on its own.

There are no audio files. Everything is synthesized in the browser with the Web
Audio API, so there is nothing to download and nothing to license. Two layers run
during a question: a low hum from two slightly detuned sine voices, and a nine
beat phrase, three even, three quick, three even. As the clock runs down the
phrase repeats a little sooner and drops in pitch. Tempo stays where it is, on
the theory that a speeding pulse in a room full of people reads as stress rather
than fun.

Answering, getting it right, getting it wrong, and the final podium each have
their own short cue. The podium also throws confetti, drawn on a canvas and
skipped entirely when the browser asks for reduced motion.

### If a connection drops

Sockets reconnect on their own, backing off over eight attempts. A player who
rejoins mid-question gets the question with the correct time remaining and is
locked out if they already answered.

If a tab is closed entirely, reopening the site offers to rejoin the game that
tab was in. The host key is what proves you are the host, so a host who reopens
the site in the same browser session can take the game back over. In a different
browser, or after the browser is fully closed, the key is gone and so is host
control.

## Quiz packs

A pack is a JSON file in `public/quizzes`:

```json
{
  "title": "Richmond, Start to Finish",
  "slug": "rva",
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
wrangler.jsonc            bindings and the SQLite Durable Object migration
```

## Notes

No API keys or secrets, so the repo is safe to make public.

No web fonts and no CDN. Type is a system stack, so the page renders the same
offline, on a locked-down network, or with the network partly broken.

Nicknames are stripped of control characters and capped at sixteen. Rooms cap at
sixty players. Each player gets one answer per question, and a nickname already
connected to a game cannot be taken by someone else.
