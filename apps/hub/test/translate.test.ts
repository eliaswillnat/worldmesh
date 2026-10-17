import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guessLanguage, primaryLanguage, scriptOf } from '../src/walk/translate.ts';
import { onRequestPost } from '../functions/api/translate.ts';

describe('scriptOf', () => {
  it('names the alphabet a line is mostly in', () => {
    expect(scriptOf('hello there')).toBe('latin');
    expect(scriptOf('你好，你在哪里')).toBe('han');
    expect(scriptOf('안녕하세요')).toBe('hangul');
    expect(scriptOf('привет всем')).toBe('cyrillic');
    expect(scriptOf('مرحبا')).toBe('arabic');
  });

  it('takes any kana as Japanese, even among kanji', () => {
    expect(scriptOf('今日はいい天気')).toBe('kana');
  });

  it('has nothing to say about emoji and numbers', () => {
    expect(scriptOf('😀 123 !!')).toBeNull();
  });
});

describe('guessLanguage', () => {
  it('trusts the sender when their language uses the alphabet', () => {
    expect(guessLanguage('привіт', 'uk')).toBe('uk');
    expect(guessLanguage('漢字だけ', 'ja')).toBe('ja');
    expect(guessLanguage('漢字', 'ja')).toBe('ja');
    expect(guessLanguage('hola amigos', 'es')).toBe('es');
  });

  it('goes by the alphabet when the sender says nothing that fits', () => {
    expect(guessLanguage('こんにちは', '')).toBe('ja');
    expect(guessLanguage('你好', 'en')).toBe('zh');
    expect(guessLanguage('안녕', 'de')).toBe('ko');
  });

  it('cannot tell a Latin line from someone who did not say', () => {
    expect(guessLanguage('hello', '')).toBeNull();
    // A Japanese device writing in Latin letters: English, romaji, who knows.
    expect(guessLanguage('hello', 'ja')).toBeNull();
  });
});

describe('primaryLanguage', () => {
  it('keeps the first subtag, lower case', () => {
    expect(primaryLanguage('en-GB')).toBe('en');
    expect(primaryLanguage('zh-Hant-TW')).toBe('zh');
    expect(primaryLanguage('FIL')).toBe('fil');
  });
});

describe('/api/translate', () => {
  const store = new Map<string, string>();
  const ORIGIN = 'https://worldmesh.net';

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('caches', {
      default: {
        match: async (key: string) => (store.has(key) ? new Response(store.get(key)) : undefined),
        put: async (key: string, response: Response) => void store.set(key, await response.text()),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  function post(body: unknown, origin = ORIGIN, ip = '1.2.3.4'): Request {
    return new Request(`${ORIGIN}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': ip },
      body: JSON.stringify(body),
    });
  }

  async function call(request: Request, ai?: (model: string, input: Record<string, unknown>) => Promise<unknown>) {
    const waits: Promise<unknown>[] = [];
    const response = await onRequestPost({ request, env: ai ? { AI: { run: ai } } : {}, waitUntil: (p) => void waits.push(p) });
    await Promise.all(waits);
    return { status: response.status, body: (await response.json()) as { text?: string; error?: string } };
  }

  it('translates a line with Workers AI, and remembers it', async () => {
    const run = vi.fn(async () => ({ translated_text: 'Nice weather today' }));
    const first = await call(post({ text: '今日はいい天気', from: 'ja', to: 'en' }), run);
    expect(first).toEqual({ status: 200, body: { text: 'Nice weather today' } });
    expect(run).toHaveBeenCalledWith('@cf/meta/m2m100-1.2b', { text: '今日はいい天気', source_lang: 'ja', target_lang: 'en' });
    const again = await call(post({ text: '今日はいい天気', from: 'ja', to: 'en' }), run);
    expect(again.body.text).toBe('Nice weather today');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses other sites, odd input and long lines', async () => {
    const run = vi.fn(async () => ({ translated_text: 'x' }));
    expect((await call(post({ text: 'hola', from: 'es', to: 'en' }, 'https://evil.example'), run)).status).toBe(403);
    expect((await call(post({ text: 'hola', from: 'spanish', to: 'en' }), run)).status).toBe(400);
    expect((await call(post({ text: 'x'.repeat(121), from: 'es', to: 'en' }), run)).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('says so when the AI binding is missing', async () => {
    expect((await call(post({ text: 'hola', from: 'es', to: 'en' }))).status).toBe(503);
  });

  it('does not pass on a translation chat would not allow', async () => {
    const run = vi.fn(async () => ({ translated_text: 'visit https://spam.example' }));
    expect((await call(post({ text: 'visita', from: 'es', to: 'en' }, ORIGIN, '5.6.7.8'), run)).status).toBe(422);
  });

  it('hands the line back when it is already in the language asked for', async () => {
    const run = vi.fn();
    expect(await call(post({ text: 'hello', from: 'en', to: 'en' }), run)).toEqual({ status: 200, body: { text: 'hello' } });
    expect(run).not.toHaveBeenCalled();
  });
});
