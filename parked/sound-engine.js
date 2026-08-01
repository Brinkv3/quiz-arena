/*
 * Parked, not deleted.
 *
 * The generated audio bed from Quiz Arena: a low hum plus a nine beat phrase
 * (three even, three quick, three even) that tightens as a question's clock
 * runs down. No audio files and nothing licensed; every sound is synthesized
 * at runtime with the Web Audio API.
 *
 * It worked, but it was not earning its place during play, so it came out.
 * To put it back: paste this above the confetti section in public/index.html,
 * restore the Sound toggle in the header, and re-add the calls listed at the
 * bottom of this file.
 */

/* ------------------------------------------------------------------
   Sound. Everything here is synthesized at runtime: no audio files, no
   licences, nothing to download. Two layers.

   HUM   two detuned sine voices around 62Hz through a low-pass, always
         on once started. Meant to be felt rather than heard.

   BOP   a nine beat phrase: three even, three quick, three even, then a
         rest. The stumble in the middle is what stops the ear filing it
         away as noise. As a question's clock runs down the phrase repeats
         sooner and drops in pitch. Tempo stays put, because a speeding
         pulse in a room full of people reads as stress.
   ------------------------------------------------------------------ */
const Sound = (() => {
  let actx = null, master = null, humGain = null, bopGain = null;
  let humVoices = [], on = false, loopTimer = null;
  let urgency = 0; // 0 relaxed .. 1 clock nearly out

  // Nine beats over one bar: three even, three quick, three even.
  // Offsets are fractions of the bar.
  const PHRASE = [0, 0.111, 0.222, 0.389, 0.444, 0.5, 0.667, 0.778, 0.889];
  const QUICK = [3, 4, 5];   // the fast middle run
  const TAIL = [8];          // the beat that falls away
  const BAR_MS = 2600;

  function ctx() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
      master = actx.createGain();
      master.gain.value = 0.9;
      master.connect(actx.destination);
      humGain = actx.createGain();
      humGain.gain.value = 0;
      bopGain = actx.createGain();
      bopGain.gain.value = 0;
      const lp = actx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 140;
      humGain.connect(lp).connect(master);
      bopGain.connect(master);
    }
    return actx;
  }

  /** Short percussive tone. Used for the bop and for every UI blip. */
  function blip(freq, dur, type, peak, dest) {
    const a = ctx();
    if (!a) return;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type || 'triangle';
    o.frequency.setValueAtTime(freq, a.currentTime);
    g.gain.setValueAtTime(0.0001, a.currentTime);
    g.gain.exponentialRampToValueAtTime(peak, a.currentTime + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g).connect(dest || master);
    o.start();
    o.stop(a.currentTime + dur + 0.02);
  }

  function startHum() {
    const a = ctx();
    if (!a || humVoices.length) return;
    for (const detune of [-6, 7]) {
      const o = a.createOscillator();
      o.type = 'sine';
      o.frequency.value = 44;
      o.detune.value = detune;
      o.connect(humGain);
      o.start();
      humVoices.push(o);
    }
    humGain.gain.setTargetAtTime(0.055, a.currentTime, 1.2);
  }

  function playPhrase() {
    const a = ctx();
    if (!a || !on) return;
    // Lower and slightly louder as the clock runs out.
    const base = 196 - urgency * 34;
    PHRASE.forEach((offset, i) => {
      const quick = QUICK.includes(i);
      const tail = TAIL.includes(i);
      // The fast run sits a fifth up; the tail drops away underneath.
      const freq = base * (quick ? 1.5 : 1) * (tail ? 0.75 : 1);
      const peak = (quick ? 0.09 : 0.13) * (tail ? 0.8 : 1)
        * (0.85 + Math.random() * 0.3) * (1 + urgency * 0.35);
      // Occasionally let the very last beat fall away.
      if (i === 8 && Math.random() < 0.3) return;
      setTimeout(() => {
        if (on) blip(freq, quick ? 0.06 : 0.1, 'triangle', peak, bopGain);
      }, offset * BAR_MS);
    });
  }

  return {
    get enabled() { return on; },

    /** Must be called from a click: browsers block audio otherwise. */
    async toggle() {
      const a = ctx();
      if (!a) return false;
      if (a.state === 'suspended') await a.resume();
      on = !on;
      if (on) {
        startHum();
        bopGain.gain.setTargetAtTime(1, a.currentTime, 0.4);
      } else {
        humGain.gain.setTargetAtTime(0, a.currentTime, 0.5);
        bopGain.gain.setTargetAtTime(0, a.currentTime, 0.3);
        clearInterval(loopTimer);
        loopTimer = null;
      }
      return on;
    },

    /** Run the phrase for the length of a question, tightening as it goes. */
    bed(seconds) {
      if (!on) return;
      clearInterval(loopTimer);
      const started = Date.now();
      urgency = 0;
      playPhrase();
      loopTimer = setInterval(() => {
        const elapsed = (Date.now() - started) / 1000;
        urgency = Math.max(0, Math.min(1, elapsed / Math.max(1, seconds)));
        if (elapsed > seconds + 1) return this.rest();
        playPhrase();
      }, BAR_MS * (1 - urgency * 0.18));
    },

    /** Stop the pulse but leave the hum breathing underneath. */
    rest() {
      clearInterval(loopTimer);
      loopTimer = null;
      urgency = 0;
    },

    tap() { if (on) blip(440, 0.06, 'square', 0.09); },
    lock() { if (on) { blip(523, 0.07, 'square', 0.1); setTimeout(() => blip(784, 0.09, 'square', 0.09), 70); } },
    right() { if (on) [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => blip(f, 0.16, 'triangle', 0.12), i * 90)); },
    wrong() { if (on) { blip(150, 0.22, 'sawtooth', 0.09); setTimeout(() => blip(110, 0.3, 'sawtooth', 0.08), 110); } },
    fanfare() {
      if (!on) return;
      [523, 659, 784, 1047, 1319].forEach((f, i) =>
        setTimeout(() => blip(f, 0.32, 'triangle', 0.13), i * 130));
    },
  };
})();


/* ------------------------------------------------------------------
   Where the calls went:

     hostQuestion()   after runTimer   -> Sound.bed(m.seconds)
     hostReveal()     at the top       -> Sound.rest()
     hostFinal()      after show       -> Sound.rest(); Sound.fanfare()
     playerQuestion() after runTimer   -> if (!m.answered) Sound.bed(m.seconds)
     playerQuestion() pad onclick      -> Sound.lock()
     playerResult()   at the top       -> Sound.rest(); correct ? right() : wrong()
     playerFinal()    after show       -> Sound.rest(); Sound.fanfare()
     leaveGame()      at the top       -> Sound.rest()

   Header control:

     <button class="btn quiet hide" id="btnSound" aria-pressed="false">Sound off</button>

     $('btnSound').onclick = async () => {
       const now = await Sound.toggle();
       $('btnSound').textContent = now ? 'Sound on' : 'Sound off';
       $('btnSound').setAttribute('aria-pressed', String(now));
       if (now) Sound.tap();
     };

   And whoami() toggled its visibility:
     $('btnSound').classList.toggle('hide', !t);
   ------------------------------------------------------------------ */
