/**
 * Quiz Arena — Worker entry point.
 *
 *   POST /api/new  -> mint an unused PIN and a host key (rate limited per IP)
 *   GET  /ws       -> upgrade to a WebSocket held by the room's Durable Object
 *
 * Everything else falls through to the static files in /public.
 */

const MAX_PIN_ATTEMPTS = 6;
const ROOMS_PER_HOUR = 20;

function randomPin() {
  const d = new Uint32Array(6);
  crypto.getRandomValues(d);
  return Array.from(d, (n) => n % 10).join('');
}

function randomKey() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const roomFor = (env, name) => env.ROOMS.get(env.ROOMS.idFromName(name));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/new' && request.method === 'POST') {
      // One counter object per client IP. A missing header means local dev.
      const ip = request.headers.get('CF-Connecting-IP');
      if (ip) {
        const limiter = roomFor(env, 'rate:' + ip);
        const check = await limiter.fetch('https://room/rate', { method: 'POST' });
        if (!check.ok) {
          return json({ error: 'Too many games started from here. Try again later.' }, 429);
        }
      }

      for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) {
        const pin = randomPin();
        const hostKey = randomKey();
        const room = roomFor(env, pin);
        const res = await room.fetch('https://room/claim', {
          method: 'POST',
          body: JSON.stringify({ pin, hostKey }),
        });
        if (res.ok) return json({ pin, hostKey });
      }
      return json({ error: 'Could not find a free PIN. Try again.' }, 503);
    }

    if (url.pathname === '/ws') {
      const pin = url.searchParams.get('pin') || '';
      if (!/^\d{6}$/.test(pin)) return new Response('Bad PIN', { status: 400 });
      return roomFor(env, pin).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------------------------------------------ */

const MAX_PLAYERS = 60;
const MAX_NAME = 16;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_QUESTIONS = 100;
const IDLE_MS = 6 * 60 * 60 * 1000; // rooms self-destruct after 6 idle hours
const RATE_WINDOW_MS = 60 * 60 * 1000;

function cleanName(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, MAX_NAME);
}

const norm = (n) => n.toLowerCase().replace(/\s+/g, ' ');

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.s = null;
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get('state')) || null;
    });
  }

  async save() {
    this.s.touched = Date.now();
    await this.ctx.storage.put('state', this.s);
  }

  /** Park the self-destruct alarm in the future unless a question clock owns it. */
  async armIdleAlarm() {
    if (this.s && this.s.phase === 'question') return;
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  async fetch(request) {
    const url = new URL(request.url);

    /* ---- counter instance, keyed by IP, not a game room ---- */
    if (url.pathname === '/rate') {
      const now = Date.now();
      const r = (await this.ctx.storage.get('rate')) || { start: now, count: 0 };
      if (now - r.start > RATE_WINDOW_MS) {
        r.start = now;
        r.count = 0;
      }
      r.count += 1;
      await this.ctx.storage.put('rate', r);
      await this.ctx.storage.setAlarm(r.start + RATE_WINDOW_MS + 1000);
      return r.count > ROOMS_PER_HOUR
        ? new Response('slow down', { status: 429 })
        : new Response('ok');
    }

    if (url.pathname === '/claim') {
      if (this.s) return new Response('taken', { status: 409 });
      const { pin, hostKey } = await request.json();
      this.s = {
        pin,
        hostKey,
        created: Date.now(),
        touched: Date.now(),
        phase: 'lobby',
        quiz: null,
        qIndex: -1,
        endsAt: 0,
        duration: 0,
        players: {},
        answers: {},
        lastReveal: null,
        lastFinal: null,
      };
      await this.save();
      await this.armIdleAlarm();
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    if (!this.s) {
      return new Response('No such game', { status: 404 });
    }

    const role = url.searchParams.get('role') === 'host' ? 'host' : 'player';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === 'host') {
      if (url.searchParams.get('key') !== this.s.hostKey) {
        return new Response('Not the host of this game', { status: 403 });
      }
      this.ctx.acceptWebSocket(server, ['host']);
      server.serializeAttachment({ role: 'host' });
      this.send(server, this.hostSnapshot());
      const stage = this.hostStage();
      if (stage) this.send(server, stage);
    } else {
      const name = cleanName(url.searchParams.get('name'));
      if (!name) return new Response('Name required', { status: 400 });

      const key = norm(name);
      const known = this.s.players[key];
      const live = this.ctx
        .getWebSockets()
        .some((ws) => (ws.deserializeAttachment() || {}).key === key);

      if (known && live) {
        return new Response('That name is already in the game', { status: 409 });
      }
      if (!known && Object.keys(this.s.players).length >= MAX_PLAYERS) {
        return new Response('This game is full', { status: 409 });
      }
      if (!known && this.s.phase !== 'lobby') {
        return new Response('This game has already started', { status: 409 });
      }

      if (!known) {
        this.s.players[key] = { name, score: 0, correct: 0 };
        await this.save();
      }

      this.ctx.acceptWebSocket(server, ['player']);
      server.serializeAttachment({ role: 'player', key, name });
      this.send(server, this.playerSnapshot(key));
      const stage = this.playerStage(key);
      if (stage) this.send(server, stage);
      this.broadcastRoster();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------------- messaging helpers ---------------- */

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (_) {
      /* socket already gone */
    }
  }

  sockets(role) {
    return this.ctx.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment() || {};
      return !role || a.role === role;
    });
  }

  toHosts(msg) {
    for (const ws of this.sockets('host')) this.send(ws, msg);
  }

  roster() {
    return Object.entries(this.s.players)
      .map(([key, p]) => ({ key, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  broadcastRoster() {
    const r = this.roster();
    this.toHosts({ t: 'roster', players: r, count: r.length });
  }

  hostSnapshot() {
    return {
      t: 'snapshot',
      role: 'host',
      pin: this.s.pin,
      phase: this.s.phase,
      quizTitle: this.s.quiz ? this.s.quiz.title : null,
      total: this.s.quiz ? this.s.quiz.questions.length : 0,
      index: this.s.qIndex,
      players: this.roster(),
    };
  }

  /** What a reconnecting host needs to redraw whatever is on screen right now. */
  hostStage() {
    const q = this.currentQuestion();
    if (this.s.phase === 'question' && q) {
      return {
        t: 'question',
        index: this.s.qIndex,
        total: this.s.quiz.questions.length,
        text: q.q,
        answers: q.a,
        seconds: Math.max(1, Math.round((this.s.endsAt - Date.now()) / 1000)),
      };
    }
    if (this.s.phase === 'reveal') return this.s.lastReveal;
    if (this.s.phase === 'final') return this.s.lastFinal;
    return null;
  }

  playerSnapshot(key) {
    const p = this.s.players[key];
    return {
      t: 'snapshot',
      role: 'player',
      pin: this.s.pin,
      phase: this.s.phase,
      you: { name: p.name, score: p.score },
      index: this.s.qIndex,
      total: this.s.quiz ? this.s.quiz.questions.length : 0,
    };
  }

  /** What a reconnecting player needs. Mid-question they get the live clock. */
  playerStage(key) {
    const q = this.currentQuestion();
    if (this.s.phase === 'question' && q) {
      return {
        t: 'question',
        index: this.s.qIndex,
        total: this.s.quiz.questions.length,
        answers: q.a.length,
        seconds: Math.max(1, Math.round((this.s.endsAt - Date.now()) / 1000)),
        answered: !!this.s.answers[key],
      };
    }
    if (this.s.phase === 'final') {
      const board = this.roster();
      const rank = board.findIndex((b) => b.key === key) + 1;
      return {
        t: 'final',
        rank,
        of: board.length,
        score: this.s.players[key].score,
        podium: board.slice(0, 3),
      };
    }
    return null;
  }

  currentQuestion() {
    if (!this.s.quiz) return null;
    return this.s.quiz.questions[this.s.qIndex] || null;
  }

  /* ---------------- socket events ---------------- */

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    const who = ws.deserializeAttachment() || {};

    if (who.role === 'host') {
      if (msg.t === 'load') return this.loadQuiz(ws, msg.quiz);
      if (msg.t === 'start') return this.startQuestion(0);
      if (msg.t === 'skip') return this.closeQuestion();
      if (msg.t === 'next') return this.startQuestion(this.s.qIndex + 1);
      return;
    }

    if (msg.t === 'answer') return this.recordAnswer(who.key, msg.choice);
  }

  async webSocketClose(ws) {
    const who = ws.deserializeAttachment() || {};
    if (who.role === 'player') this.broadcastRoster();
  }

  /* ---------------- game logic ---------------- */

  async loadQuiz(ws, quiz) {
    const questions = Array.isArray(quiz && quiz.questions) ? quiz.questions : [];
    const clean = questions
      .slice(0, MAX_QUESTIONS)
      .filter(
        (q) =>
          q &&
          typeof q.q === 'string' &&
          Array.isArray(q.a) &&
          q.a.length >= 2 &&
          q.a.length <= 4 &&
          Number.isInteger(q.correct) &&
          q.correct >= 0 &&
          q.correct < q.a.length
      )
      .map((q) => ({
        q: String(q.q).slice(0, 300),
        a: q.a.map((x) => String(x).slice(0, 120)),
        correct: q.correct,
        seconds: Math.min(120, Math.max(5, Number(q.seconds) || 20)),
      }));

    if (!clean.length) {
      return this.send(ws, { t: 'error', message: 'That quiz has no usable questions.' });
    }

    this.s.quiz = {
      title: String((quiz && quiz.title) || 'Untitled quiz').slice(0, 80),
      questions: clean,
    };
    this.s.phase = 'lobby';
    this.s.qIndex = -1;
    await this.save();
    this.toHosts(this.hostSnapshot());
  }

  async startQuestion(index) {
    if (!this.s.quiz) return;
    if (index >= this.s.quiz.questions.length) return this.finish();

    const q = this.s.quiz.questions[index];
    this.s.phase = 'question';
    this.s.qIndex = index;
    this.s.duration = q.seconds * 1000;
    this.s.endsAt = Date.now() + this.s.duration;
    this.s.answers = {};
    await this.save();
    await this.ctx.storage.setAlarm(this.s.endsAt + 250);

    this.toHosts({
      t: 'question',
      index,
      total: this.s.quiz.questions.length,
      text: q.q,
      answers: q.a,
      seconds: q.seconds,
    });

    for (const ws of this.sockets('player')) {
      this.send(ws, {
        t: 'question',
        index,
        total: this.s.quiz.questions.length,
        answers: q.a.length,
        seconds: q.seconds,
        answered: false,
      });
    }
  }

  async recordAnswer(key, choice) {
    if (this.s.phase !== 'question') return;
    if (!this.s.players[key] || this.s.answers[key]) return;
    const q = this.currentQuestion();
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.a.length) return;

    this.s.answers[key] = { choice, at: Date.now() };
    await this.save();

    const answered = Object.keys(this.s.answers).length;
    this.toHosts({ t: 'answered', answered, total: Object.keys(this.s.players).length });

    if (answered >= Object.keys(this.s.players).length) await this.closeQuestion();
  }

  async closeQuestion() {
    if (this.s.phase !== 'question') return;
    const q = this.currentQuestion();
    const tally = q.a.map(() => 0);
    const gains = {};

    for (const [key, ans] of Object.entries(this.s.answers)) {
      tally[ans.choice]++;
      if (ans.choice !== q.correct) {
        gains[key] = 0;
        continue;
      }
      const started = this.s.endsAt - this.s.duration;
      const elapsed = Math.max(0, Math.min(this.s.duration, ans.at - started));
      const gain = Math.round(1000 * (1 - 0.5 * (elapsed / this.s.duration)));
      gains[key] = gain;
      this.s.players[key].score += gain;
      this.s.players[key].correct += 1;
    }

    this.s.phase = 'reveal';

    const board = this.roster();
    const rankOf = new Map(board.map((p, i) => [p.key, i + 1]));
    const isLast = this.s.qIndex + 1 >= this.s.quiz.questions.length;

    this.s.lastReveal = {
      t: 'reveal',
      correct: q.correct,
      tally,
      answers: q.a,
      leaderboard: board.slice(0, 8),
      isLast,
    };
    await this.save();
    await this.armIdleAlarm();

    this.toHosts(this.s.lastReveal);

    for (const ws of this.sockets('player')) {
      const who = ws.deserializeAttachment() || {};
      const ans = this.s.answers[who.key];
      this.send(ws, {
        t: 'result',
        answered: !!ans,
        correct: !!ans && ans.choice === q.correct,
        gained: gains[who.key] || 0,
        score: this.s.players[who.key] ? this.s.players[who.key].score : 0,
        rank: rankOf.get(who.key) || 0,
        of: board.length,
        isLast,
      });
    }
  }

  async finish() {
    this.s.phase = 'final';
    const board = this.roster();
    this.s.lastFinal = { t: 'final', leaderboard: board.slice(0, 10), count: board.length };
    await this.save();
    await this.armIdleAlarm();

    this.toHosts(this.s.lastFinal);

    const rankOf = new Map(board.map((p, i) => [p.key, i + 1]));
    for (const ws of this.sockets('player')) {
      const who = ws.deserializeAttachment() || {};
      this.send(ws, {
        t: 'final',
        rank: rankOf.get(who.key) || 0,
        of: board.length,
        score: this.s.players[who.key] ? this.s.players[who.key].score : 0,
        podium: board.slice(0, 3),
      });
    }
  }

  async alarm() {
    // A live question whose clock ran out.
    if (this.s && this.s.phase === 'question' && Date.now() >= this.s.endsAt) {
      return this.closeQuestion();
    }
    // Still inside the idle window: push the alarm back and wait.
    if (this.s && Date.now() - this.s.touched < IDLE_MS) {
      return this.ctx.storage.setAlarm(this.s.touched + IDLE_MS);
    }
    // Idle room, or a spent rate-limit counter. Either way, clear it out.
    await this.ctx.storage.deleteAll();
    this.s = null;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, 'Room expired');
      } catch (_) {}
    }
  }
}
