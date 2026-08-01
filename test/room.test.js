import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../src/index.js';

/* A stand-in for the Durable Object context: storage, alarms, sockets. */
function makeCtx() {
  const store = new Map();
  const ctx = {
    _alarm: null,
    _pending: null,
    _sockets: [],
    blockConcurrencyWhile(f) { ctx._pending = f(); return ctx._pending; },
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => void store.set(k, v),
      deleteAll: async () => store.clear(),
      setAlarm: async (t) => void (ctx._alarm = t),
    },
    getWebSockets: () => ctx._sockets,
    acceptWebSocket: () => {},
  };
  return ctx;
}

function fakeSocket(attachment, sink) {
  return {
    send: (s) => sink.push({ to: attachment, msg: JSON.parse(s) }),
    deserializeAttachment: () => attachment,
    serializeAttachment: () => {},
    close: () => {},
  };
}

async function newRoom() {
  const ctx = makeCtx();
  const room = new GameRoom(ctx, {});
  await ctx._pending;
  return { ctx, room };
}

async function claimed() {
  const { ctx, room } = await newRoom();
  await room.fetch(new Request('https://room/claim', {
    method: 'POST',
    body: JSON.stringify({ pin: '123456', hostKey: 'secret' }),
  }));
  const sink = [];
  const host = fakeSocket({ role: 'host' }, sink);
  ctx._sockets.push(host);
  return { ctx, room, host, sink };
}

const TWO_Q = {
  title: 'Test quiz',
  questions: [
    { q: 'One?', a: ['a', 'b', 'c', 'd'], correct: 1, seconds: 10 },
    { q: 'Two?', a: ['a', 'b'], correct: 0, seconds: 10 },
  ],
};

function addPlayers(ctx, sink, names) {
  const out = {};
  for (const n of names) {
    const s = fakeSocket({ role: 'player', key: n, name: n }, sink);
    ctx._sockets.push(s);
    out[n] = s;
  }
  return out;
}

/* ---------------- claiming a PIN ---------------- */

test('claim sets up a room', async () => {
  const { room } = await claimed();
  assert.equal(room.s.pin, '123456');
  assert.equal(room.s.phase, 'lobby');
});

test('a claimed PIN cannot be claimed twice', async () => {
  const { room } = await claimed();
  const res = await room.fetch(new Request('https://room/claim', {
    method: 'POST',
    body: JSON.stringify({ pin: '123456', hostKey: 'other' }),
  }));
  assert.equal(res.status, 409);
  assert.equal(room.s.hostKey, 'secret');
});

/* ---------------- rate limiting ---------------- */

test('rate limiter allows a burst then refuses', async () => {
  const { room } = await newRoom();
  const hit = () => room.fetch(new Request('https://room/rate', { method: 'POST' }));
  for (let i = 0; i < 20; i++) assert.equal((await hit()).status, 200);
  assert.equal((await hit()).status, 429);
});

/* ---------------- quiz validation ---------------- */

test('malformed questions are dropped, good ones kept', async () => {
  const { room, host } = await claimed();
  await room.loadQuiz(host, {
    title: 'Mixed',
    questions: [
      { q: 'ok', a: ['x', 'y'], correct: 0 },
      { q: 'no answers', a: [], correct: 0 },
      { q: 'index out of range', a: ['x', 'y'], correct: 9 },
      { q: 'correct not an integer', a: ['x', 'y'], correct: '1' },
      { a: ['x', 'y'], correct: 0 },
    ],
  });
  assert.equal(room.s.quiz.questions.length, 1);
  assert.equal(room.s.quiz.questions[0].q, 'ok');
});

test('a quiz with nothing usable is refused', async () => {
  const { room, host, sink } = await claimed();
  await room.loadQuiz(host, { title: 'Bad', questions: [{ q: 'x', a: [], correct: 0 }] });
  assert.equal(room.s.quiz, null);
  assert.equal(sink.at(-1).msg.t, 'error');
});

test('question length is clamped into range', async () => {
  const { room, host } = await claimed();
  await room.loadQuiz(host, {
    questions: [
      { q: 'fast', a: ['x', 'y'], correct: 0, seconds: 1 },
      { q: 'slow', a: ['x', 'y'], correct: 0, seconds: 9999 },
      { q: 'blank', a: ['x', 'y'], correct: 0 },
    ],
  });
  assert.deepEqual(room.s.quiz.questions.map((q) => q.seconds), [5, 120, 20]);
});

/* ---------------- scoring ---------------- */

test('an instant correct answer scores the maximum', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann']);
  room.s.players = { ann: { name: 'ann', score: 0, correct: 0 } };
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  await room.recordAnswer('ann', 1);
  assert.equal(room.s.players.ann.score, 1000);
});

test('a slow correct answer scores less, never below half', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann']);
  room.s.players = { ann: { name: 'ann', score: 0, correct: 0 } };
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  // Pretend the answer arrived with the clock nearly out.
  room.s.answers.ann = { choice: 1, at: room.s.endsAt - 1 };
  await room.closeQuestion();
  const score = room.s.players.ann.score;
  assert.ok(score > 500 - 1 && score < 510, 'expected roughly half, got ' + score);
});

test('a wrong answer scores nothing', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann']);
  room.s.players = { ann: { name: 'ann', score: 0, correct: 0 } };
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  await room.recordAnswer('ann', 3);
  assert.equal(room.s.players.ann.score, 0);
  assert.equal(room.s.players.ann.correct, 0);
});

/* ---------------- answer guards ---------------- */

test('a second answer from the same player is ignored', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann', 'bob']);
  room.s.players = {
    ann: { name: 'ann', score: 0, correct: 0 },
    bob: { name: 'bob', score: 0, correct: 0 },
  };
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  await room.recordAnswer('ann', 3);
  await room.recordAnswer('ann', 1);
  assert.equal(room.s.answers.ann.choice, 3);
});

test('answers from strangers and out of range choices are ignored', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann']);
  room.s.players = { ann: { name: 'ann', score: 0, correct: 0 } };
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  await room.recordAnswer('nobody', 1);
  await room.recordAnswer('ann', 99);
  await room.recordAnswer('ann', -1);
  assert.deepEqual(room.s.answers, {});
});

test('answers after the question closes are ignored', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann']);
  room.s.players = { ann: { name: 'ann', score: 0, correct: 0 } };
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  await room.closeQuestion();
  await room.recordAnswer('ann', 1);
  assert.deepEqual(room.s.answers, {});
});

/* ---------------- flow ---------------- */

test('the question closes early once everyone has answered', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann', 'bob']);
  room.s.players = {
    ann: { name: 'ann', score: 0, correct: 0 },
    bob: { name: 'bob', score: 0, correct: 0 },
  };
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  await room.recordAnswer('ann', 1);
  assert.equal(room.s.phase, 'question');
  await room.recordAnswer('bob', 3);
  assert.equal(room.s.phase, 'reveal');
});

test('the reveal tallies every answer and flags the last question', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann', 'bob']);
  room.s.players = {
    ann: { name: 'ann', score: 0, correct: 0 },
    bob: { name: 'bob', score: 0, correct: 0 },
  };
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  await room.recordAnswer('ann', 1);
  await room.recordAnswer('bob', 3);
  assert.deepEqual(room.s.lastReveal.tally, [0, 1, 0, 1]);
  assert.equal(room.s.lastReveal.correct, 1);
  assert.equal(room.s.lastReveal.isLast, false);

  await room.startQuestion(1);
  await room.closeQuestion();
  assert.equal(room.s.lastReveal.isLast, true);
});

test('starting past the end finishes the game, ranked by score', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann', 'bob']);
  room.s.players = {
    ann: { name: 'ann', score: 300, correct: 0 },
    bob: { name: 'bob', score: 900, correct: 0 },
  };
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(2);
  assert.equal(room.s.phase, 'final');
  assert.deepEqual(room.s.lastFinal.leaderboard.map((p) => p.name), ['bob', 'ann']);
});

/* ---------------- reconnect payloads ---------------- */

test('a host rejoining mid-question gets the question and the time left', async () => {
  const { room, host } = await claimed();
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  const stage = room.hostStage();
  assert.equal(stage.t, 'question');
  assert.equal(stage.text, 'One?');
  assert.ok(stage.seconds > 0 && stage.seconds <= 10);
});

test('a host rejoining at the reveal gets the reveal back', async () => {
  const { room, host } = await claimed();
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  await room.closeQuestion();
  assert.equal(room.hostStage().t, 'reveal');
});

test('a player rejoining mid-question learns whether they already answered', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann', 'bob']);
  room.s.players = {
    ann: { name: 'ann', score: 0, correct: 0 },
    bob: { name: 'bob', score: 0, correct: 0 },
  };
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  await room.recordAnswer('ann', 1);
  assert.equal(room.playerStage('ann').answered, true);
  assert.equal(room.playerStage('bob').answered, false);
  assert.equal(room.playerStage('bob').answers, 4);
});

test('a player rejoining after the end gets their placing', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann', 'bob']);
  room.s.players = {
    ann: { name: 'ann', score: 100, correct: 0 },
    bob: { name: 'bob', score: 800, correct: 0 },
  };
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(2);
  const stage = room.playerStage('ann');
  assert.equal(stage.t, 'final');
  assert.equal(stage.rank, 2);
  assert.equal(stage.of, 2);
});

/* ---------------- cleanup ---------------- */

test('an idle room is not deleted while inside its window', async () => {
  const { room } = await claimed();
  await room.alarm();
  assert.ok(room.s, 'room should survive');
});

test('a room past its idle window deletes itself', async () => {
  const { room } = await claimed();
  room.s.touched = Date.now() - 7 * 60 * 60 * 1000;
  await room.alarm();
  assert.equal(room.s, null);
});

test('the alarm closes a question whose clock has run out', async () => {
  const { room, host } = await claimed();
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  room.s.endsAt = Date.now() - 1;
  await room.alarm();
  assert.equal(room.s.phase, 'reveal');
});

test('a running question keeps its own alarm rather than the idle one', async () => {
  const { ctx, room, host } = await claimed();
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  const before = ctx._alarm;
  await room.armIdleAlarm();
  assert.equal(ctx._alarm, before, 'idle alarm must not stomp the question clock');
});
