// Runs the grading simulations off the main thread so the page never freezes.
import { evaluate } from './engine.js';

let playbook = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { playbook = m.playbook; return; }
  if (m.type === 'eval') {
    const res = evaluate(m.state, m.opts, m.tempo, m.useTO, playbook, m.seed, m.n);
    self.postMessage({
      type: 'eval', id: m.id,
      res: res.map(({ call, wp, delta, se, grade }) => ({ call, wp, delta, se, grade })),
    });
  }
};
