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

/* Both questions carry four answers so tests can pick any index 0-3.
   Question order is shuffled on load, so never assume which comes first. */
const TWO_Q = {
  title: 'Test quiz',
  questions: [
    { q: 'One?', a: ['1a', '1b', '1c', '1d'], correct: 1, seconds: 10 },
    { q: 'Two?', a: ['2a', '2b', '2c', '2d'], correct: 0, seconds: 10 },
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
  assert.deepEqual(room.s.quiz.questions.map((q) => q.seconds).sort((a, b) => a - b), [5, 20, 120]);
});

/* ---------------- scoring ---------------- */

test('an instant correct answer scores the maximum', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann']);
  room.s.players = { ann: { name: 'ann', score: 0, correct: 0 } };
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  await room.recordAnswer('ann', room.currentQuestion().correct);
  assert.equal(room.s.players.ann.score, 1000);
});

test('a slow correct answer scores less, never below half', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann']);
  room.s.players = { ann: { name: 'ann', score: 0, correct: 0 } };
  await room.loadQuiz(host, TWO_Q);
  await room.startQuestion(0);
  // Pretend the answer arrived with the clock nearly out.
  room.s.answers.ann = { choice: room.currentQuestion().correct, at: room.s.endsAt - 1 };
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
  const wrong = (room.currentQuestion().correct + 1) % 4;
  await room.recordAnswer('ann', wrong);
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
  await room.recordAnswer('ann', 0);
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
  await room.recordAnswer('ann', 0);
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
  await room.recordAnswer('ann', 0);
  await room.recordAnswer('bob', 3);
  assert.deepEqual(room.s.lastReveal.tally, [1, 0, 0, 1]);
  assert.equal(room.s.lastReveal.correct, room.s.quiz.questions[0].correct);
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
  assert.ok(['One?', 'Two?'].includes(stage.text));
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
  await room.recordAnswer('ann', 0);
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

/* ---------------- shuffle, draw, rematch ---------------- */

const BIG = {
  title: 'Pool',
  draw: 3,
  questions: Array.from({ length: 12 }, (_, i) => ({
    q: 'Q' + i, a: ['a', 'b', 'c', 'd'], correct: i % 4, seconds: 10,
  })),
};

test('a pack with draw serves only that many questions', async () => {
  const { room, host } = await claimed();
  await room.loadQuiz(host, BIG);
  assert.equal(room.s.quiz.questions.length, 3);
  assert.equal(room.s.pack.questions.length, 12, 'full pack is kept');
});

test('a pack without draw serves everything', async () => {
  const { room, host } = await claimed();
  await room.loadQuiz(host, TWO_Q);
  assert.equal(room.s.quiz.questions.length, 2);
});

test('draw larger than the pool is capped at the pool', async () => {
  const { room, host } = await claimed();
  await room.loadQuiz(host, { title: 'Small', draw: 99, questions: TWO_Q.questions });
  assert.equal(room.s.quiz.questions.length, 2);
});

test('shuffling preserves which answer is correct', async () => {
  const { room, host } = await claimed();
  // Each answer is distinct so we can follow it through the shuffle.
  await room.loadQuiz(host, {
    title: 'Track',
    questions: [{ q: 'x', a: ['w', 'x', 'y', 'z'], correct: 2, seconds: 10 }],
  });
  const q = room.s.quiz.questions[0];
  assert.equal(q.a[q.correct], 'y', 'correct index must still point at the right answer');
  assert.equal(q.a.length, 4);
  assert.deepEqual([...q.a].sort(), ['w', 'x', 'y', 'z'], 'no answers lost or duplicated');
});

test('dealing repeatedly produces different rounds', async () => {
  const { room, host } = await claimed();
  await room.loadQuiz(host, BIG);
  const rounds = new Set();
  for (let i = 0; i < 25; i++) {
    rounds.add(room.dealRound().questions.map((q) => q.q).join(','));
  }
  assert.ok(rounds.size > 1, 'drawing from a pool should vary between games');
});

test('rematch zeroes scores and deals a fresh round', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann']);
  room.s.players = { ann: { name: 'ann', score: 900, correct: 4 } };
  await room.loadQuiz(host, BIG);
  await room.startQuestion(0);
  await room.closeQuestion();

  await room.rematch();
  assert.equal(room.s.players.ann.score, 0);
  assert.equal(room.s.players.ann.correct, 0);
  assert.equal(room.s.phase, 'lobby');
  assert.equal(room.s.qIndex, -1);
  assert.equal(room.s.lastReveal, null);
  assert.equal(room.s.quiz.questions.length, 3);
});

test('rematch on a room with no pack does nothing', async () => {
  const { room } = await claimed();
  await room.rematch();
  assert.equal(room.s.phase, 'lobby');
});

test('a rematched game can be played through again', async () => {
  const { ctx, room, host, sink } = await claimed();
  addPlayers(ctx, sink, ['ann']);
  room.s.players = { ann: { name: 'ann', score: 0, correct: 0 } };
  await room.loadQuiz(host, BIG);
  await room.rematch();
  await room.startQuestion(0);
  assert.equal(room.s.phase, 'question');
  const q = room.s.quiz.questions[0];
  await room.recordAnswer('ann', q.correct);
  assert.ok(room.s.players.ann.score > 0, 'scoring works after a rematch');
});

test('a large pack is not truncated below its size', async () => {
  const { room, host } = await claimed();
  const big = {
    title: 'Large',
    draw: 12,
    questions: Array.from({ length: 200 }, (_, i) => ({
      q: 'Q' + i, a: ['a', 'b', 'c', 'd'], correct: 0, seconds: 10,
    })),
  };
  await room.loadQuiz(host, big);
  assert.equal(room.s.pack.questions.length, 200, 'whole pack retained');
  assert.equal(room.s.quiz.questions.length, 12, 'round respects draw');
});
