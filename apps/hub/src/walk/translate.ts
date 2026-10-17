/**
 * Translating what other people say in the lobby, into the language this
 * device reads. On the device when the browser can (Chrome's built-in
 * Translator and LanguageDetector: free, and the line never leaves the
 * device); otherwise through the hub's /api/translate (Workers AI).
 *
 * Which lines get the 文A mark: the browser's own language detector when it
 * has one and is sure; otherwise the alphabet the line is written in; and for
 * Latin-alphabet lines, the language the sender's device reads, which their
 * client sends along with the line.
 */

/** The primary subtag of a language tag: 'en-GB' → 'en', 'zh-Hant-TW' → 'zh'. */
export function primaryLanguage(tag: string): string {
  return tag.toLowerCase().split(/[-_]/)[0] ?? '';
}

/** The language this device reads, as a primary subtag. */
export function deviceLanguage(): string {
  const tag = typeof navigator === 'undefined' ? '' : navigator.languages?.[0] ?? navigator.language ?? '';
  const primary = primaryLanguage(tag);
  return /^[a-z]{2,3}$/.test(primary) ? primary : 'en';
}

export type Script = 'latin' | 'han' | 'kana' | 'hangul' | 'cyrillic' | 'arabic' | 'hebrew' | 'thai' | 'devanagari' | 'greek';

const SCRIPTS: Array<[Script, RegExp]> = [
  ['kana', /[぀-ヿ]/u],
  ['hangul', /[가-힯ᄀ-ᇿ]/u],
  ['han', /\p{Script=Han}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['thai', /\p{Script=Thai}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['greek', /\p{Script=Greek}/u],
  ['latin', /\p{Script=Latin}/u],
];

/**
 * The alphabet a line is mostly written in, or null for one with no letters
 * (emoji, numbers). Any kana makes it Japanese, even among kanji.
 */
export function scriptOf(text: string): Script | null {
  const counts = new Map<Script, number>();
  for (const char of text) {
    for (const [script, pattern] of SCRIPTS) {
      if (!pattern.test(char)) continue;
      counts.set(script, (counts.get(script) ?? 0) + 1);
      break;
    }
  }
  if (counts.has('kana')) return 'kana';
  let best: Script | null = null;
  let most = 0;
  for (const [script, count] of counts) {
    if (count > most) {
      best = script;
      most = count;
    }
  }
  return best;
}

/** The language a line in this alphabet most likely is, when nothing better is known. */
const SCRIPT_LANGUAGE: Record<Exclude<Script, 'latin'>, string> = {
  kana: 'ja',
  han: 'zh',
  hangul: 'ko',
  cyrillic: 'ru',
  arabic: 'ar',
  hebrew: 'he',
  thai: 'th',
  devanagari: 'hi',
  greek: 'el',
};

/** The alphabets a language is written in. Anything not listed is Latin. */
const LANGUAGE_SCRIPTS: Record<string, Script[]> = {
  ja: ['kana', 'han'],
  zh: ['han'],
  ko: ['hangul', 'han'],
  ru: ['cyrillic'],
  uk: ['cyrillic'],
  be: ['cyrillic'],
  bg: ['cyrillic'],
  sr: ['cyrillic', 'latin'],
  mk: ['cyrillic'],
  kk: ['cyrillic'],
  mn: ['cyrillic'],
  ar: ['arabic'],
  fa: ['arabic'],
  ur: ['arabic'],
  he: ['hebrew'],
  yi: ['hebrew'],
  th: ['thai'],
  hi: ['devanagari'],
  mr: ['devanagari'],
  ne: ['devanagari'],
  el: ['greek'],
};

export function scriptsOf(language: string): Script[] {
  return LANGUAGE_SCRIPTS[language] ?? ['latin'];
}

/**
 * The language a line is most likely in, from its alphabet and the sender's
 * device language ('' when unknown). Null when there is no telling.
 */
export function guessLanguage(text: string, senderLanguage: string): string | null {
  const script = scriptOf(text);
  if (!script) return null;
  // Someone whose device reads a language in this alphabet probably wrote in it.
  if (senderLanguage && scriptsOf(senderLanguage).includes(script)) return senderLanguage;
  if (script === 'latin') return null;
  return SCRIPT_LANGUAGE[script];
}

interface Detector {
  detect(text: string): Promise<Array<{ detectedLanguage: string; confidence: number }>>;
}
interface DetectorFactory {
  availability(): Promise<string>;
  create(): Promise<Detector>;
}
interface Translator {
  translate(text: string): Promise<string>;
}
interface TranslatorFactory {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<Translator>;
}

const builtIn = globalThis as unknown as { LanguageDetector?: DetectorFactory; Translator?: TranslatorFactory };

/** Asking the browser's built-in models can stall (a model still loading, a browser that only half has it). */
const ON_DEVICE_MS = 1500;
const ON_DEVICE_TRANSLATE_MS = 4000;

/** `work`'s answer, or `fallback` if it takes longer than `ms` or fails. */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Shorter lines than this are too little for the detector to be sure of. */
const DETECT_MIN = 4;
const DETECT_CONFIDENCE = 0.7;

let detector: Promise<Detector | null> | null = null;

/** The browser's own detector, if it has one ready without a download. */
function onDeviceDetector(): Promise<Detector | null> {
  detector ??= (async () => {
    const factory = builtIn.LanguageDetector;
    if (!factory) return null;
    if ((await within(factory.availability(), ON_DEVICE_MS, 'unavailable')) !== 'available') return null;
    return within(factory.create(), ON_DEVICE_MS, null);
  })();
  return detector;
}

/** The language a line is in: the browser's detector when sure, otherwise a guess. */
export async function languageOf(text: string, senderLanguage: string): Promise<string | null> {
  if (text.trim().length >= DETECT_MIN) {
    const found = await onDeviceDetector();
    if (found) {
      const [top] = await within(found.detect(text), ON_DEVICE_MS, []);
      if (top && top.confidence >= DETECT_CONFIDENCE && top.detectedLanguage !== 'und') return primaryLanguage(top.detectedLanguage);
    }
  }
  return guessLanguage(text, senderLanguage);
}

/** Whether a line is in some other language than this device reads. */
export async function isForeign(text: string, senderLanguage: string): Promise<boolean> {
  const language = await languageOf(text, senderLanguage);
  return !!language && language !== deviceLanguage();
}

const translators = new Map<string, Promise<Translator | null>>();
const translations = new Map<string, Promise<string>>();

/** The browser's own translator for this pair, once it is on the device. Starts the download otherwise, for next time. */
async function onDeviceTranslator(from: string, to: string): Promise<Translator | null> {
  const factory = builtIn.Translator;
  if (!factory) return null;
  const pair = { sourceLanguage: from, targetLanguage: to };
  const key = `${from}>${to}`;
  const availability = await within(factory.availability(pair), ON_DEVICE_MS, 'unavailable');
  if (availability === 'unavailable') return null;
  let made = translators.get(key);
  if (!made) {
    // Called from the click or tap, which a download needs.
    made = factory.create(pair).catch(() => null);
    translators.set(key, made);
  }
  if (availability !== 'available') return null;
  return within(made, ON_DEVICE_MS, null);
}

/**
 * Translate a line someone said into this device's language. Throws when
 * neither the browser nor the hub can.
 */
export function translate(text: string, senderLanguage: string): Promise<string> {
  const to = deviceLanguage();
  const key = `${to}|${senderLanguage}|${text}`;
  let pending = translations.get(key);
  if (!pending) {
    pending = translateNow(text, senderLanguage, to);
    translations.set(key, pending);
    pending.catch(() => translations.delete(key));
  }
  return pending;
}

async function translateNow(text: string, senderLanguage: string, to: string): Promise<string> {
  // No telling from the line itself: what the sender's device reads, or English.
  const from = (await languageOf(text, senderLanguage)) ?? (senderLanguage || 'en');
  if (from === to) return text;
  const local = await onDeviceTranslator(from, to);
  if (local) {
    const out = (await within(local.translate(text), ON_DEVICE_TRANSLATE_MS, '')).trim();
    if (out) return out;
  }
  const response = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, from, to }),
  });
  if (!response.ok) throw new Error(`translate: ${response.status}`);
  const answer = (await response.json()) as { text?: unknown };
  if (typeof answer.text !== 'string' || !answer.text) throw new Error('translate: empty');
  return answer.text;
}
