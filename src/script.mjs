// A reel's script: what is SAID in the video (not the caption). The hook is the first sentences; the rest is the body.
// Pure module (no database or files), so it can be reused by scripts and tests.

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const wordCount = (s) => (clean(s).match(/\S+/g) || []).length;

// Accepts a script JSON ({chapters:[{label, beats:[{text}]}]}), an object {hook, text} or plain text.
export function parseScript(input) {
  if (input == null) return null;
  let data = input;
  if (typeof input === 'string') {
    const t = input.replace(/^﻿/, '').trim();
    if (!t) return null;
    if (t.startsWith('{')) { try { data = JSON.parse(t); } catch { data = t; } } else data = t;
  }
  if (typeof data === 'object' && Array.isArray(data.chapters)) {
    const beats = data.chapters.map((c) => ({ label: String(c.label || ''), texts: (c.beats || []).map((b) => clean(b.text)).filter(Boolean) }));
    const all = beats.flatMap((c) => c.texts);
    if (!all.length) return null;
    const first = beats.find((c) => c.texts.length);
    const hookTexts = /hook|gancho/i.test(first.label) ? first.texts : all.slice(0, 2);
    return done(hookTexts.join(' '), all.join(' '));
  }
  if (typeof data === 'object') {
    const script = clean(data.text ?? data.script ?? data.texto ?? data.guion ?? '');
    const hook = clean(data.hook ?? '') || firstSentences(script);
    return hook || script ? done(hook, script || hook) : null;
  }
  const script = clean(data);
  return done(firstSentences(script), script);
}

function firstSentences(text, n = 2) {
  const parts = clean(text).match(/[^.!?]*[.!?]+|[^.!?]+$/g) || [];
  return clean(parts.slice(0, n).join(' '));
}

function done(hook, script) {
  return { hook: clean(hook).slice(0, 400), script: clean(script).slice(0, 6000), words: wordCount(script) };
}

// Approximate seconds of speech: about 2.6 words per second, a typical voice-over pace
export const estSeconds = (words) => (words ? Math.round(words / 2.6) : null);

// Hook traits that can be measured without AI (English and Spanish words)
const NUM_WORDS = /\b(two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|hundred|thousand|million|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cien|mil|millón|millones)\b/i;
export function hookTraits(hook) {
  const h = clean(hook), low = h.toLowerCase();
  const words = wordCount(h);
  return {
    number: /\d/.test(h) || NUM_WORDS.test(low),
    question: /[¿?]/.test(h),
    you: /\b(you|your|you're|tu|tus|te|ti|usted|tienes|puedes|haces|quieres)\b/i.test(low),
    contrarian: /\b(nobody|never|stop|don't use|mistake|lie|forget|no longer|nadie|nunca|deja de|dejen de|no uses|error|mentira|olvida|ya no|jamás)\b/i.test(low),
    brand: /\b(claude|chatgpt|openai|gemini|google|apple|nvidia|meta|instagram|youtube|tiktok|shopify|paypal|notion|canva)\b/i.test(low),
    short: words > 0 && words <= 12,
  };
}
export const TRAITS = ['number', 'question', 'you', 'contrarian', 'brand', 'short'];
