/**
 * Chat line filter shared by the presence worker (authoritative) and the hub
 * client (instant feedback). Blocks sexual words, insults, slurs, threats and
 * anything that looks like a web link. Matching is per word so innocent words such as "document",
 * "Sussex" or "scumbag" are left alone.
 */

/** Words blocked when a chat word equals them exactly. */
const BLOCKED_WORDS = new Set([
  'sex', 'sexy', 'sexual', 'sexting', 'sext', 'cum', 'cums', 'cumming', 'cumshot', 'jizz',
  'porn', 'porno', 'porns', 'pornhub', 'xxx', 'nude', 'nudes', 'naked', 'nsfw', 'onlyfans',
  'dick', 'dicks', 'cock', 'cocks', 'penis', 'pussy', 'vagina', 'boobs', 'tits', 'titties',
  'blowjob', 'handjob', 'horny', 'milf', 'hentai', 'orgasm', 'masturbate', 'masturbating',
  'rape', 'raped', 'rapist', 'whore', 'whores', 'slut', 'sluts', 'slutty', 'hoe', 'hoes', 'thot',
  'fuck', 'fucks', 'fucked', 'fucking', 'fucker', 'fuckers', 'fuckface', 'motherfucker', 'mf', 'stfu', 'gtfo',
  'boob', 'tit', 'butthole', 'anal', 'anus', 'dildo', 'vibrator', 'fetish', 'bdsm', 'kinky', 'erotic',
  'cunt', 'cunts', 'cunty', 'twat', 'twats', 'bitch', 'bitches', 'bitchy', 'biatch', 'bastard', 'bastards',
  'asshole', 'assholes', 'arsehole', 'ass', 'arse', 'dickhead', 'dipshit', 'shithead', 'shit', 'shitty',
  'prick', 'pricks', 'wanker', 'wankers', 'tosser', 'douche', 'douchebag', 'jackass', 'dumbass',
  'idiot', 'idiots', 'moron', 'morons', 'stupid', 'dumb', 'loser', 'losers', 'imbecile', 'cretin',
  'retard', 'retards', 'retarded', 'tard', 'spaz', 'spastic', 'mongoloid', 'freak', 'creep',
  'ugly', 'fatass', 'fatso', 'pig', 'cow', 'trash', 'garbage', 'worthless', 'pathetic', 'useless',
  'noob', 'scum', 'vermin', 'parasite', 'subhuman', 'degenerate', 'incel', 'simp', 'cuck',
  'nigger', 'niggers', 'nigga', 'niggas', 'negro', 'coon', 'jigaboo', 'darkie', 'chink', 'chinks',
  'gook', 'gooks', 'jap', 'japs', 'spic', 'spics', 'wetback', 'beaner', 'kike', 'kikes', 'hymie',
  'raghead', 'towelhead', 'sandnigger', 'paki', 'pakis', 'gypsy', 'gyppo', 'cracker', 'honky',
  'redskin', 'injun', 'squaw', 'faggot', 'faggots', 'fag', 'fags', 'dyke', 'dykes', 'tranny',
  'trannies', 'shemale', 'homo', 'queer', 'lesbo', 'nazi', 'nazis', 'hitler', 'kkk', 'heil',
  'kys', 'kms', 'diediedie', 'behead', 'lynch',
  'pedo', 'pedos', 'pedophile', 'paedophile', 'molest', 'molester', 'groomer',
]);

/** Multi-word phrases blocked anywhere in a line (matched on normalized words). */
const BLOCKED_PHRASES = [
  'kill yourself', 'kill urself', 'kill your self', 'go die', 'just die', 'hope you die', 'i hope u die',
  'neck yourself', 'hang yourself', 'end yourself', 'end your life', 'unalive yourself', 'drink bleach',
  'nobody likes you', 'no one likes you', 'everyone hates you', 'shut up', 'shut the', 'you suck',
  'u suck', 'piece of shit', 'son of a', 'your mom', 'ur mom', 'yo mama',
  'i will kill', 'ill kill you', 'i will find you', 'i know where you live', 'gonna kill',
  'send nudes', 'show me your', 'how old are you', 'how old r u', 'where do you live', 'whats your address',
  'whats your number', 'add me on', 'dm me', 'send pics', 'are you a girl', 'are you alone',
  'white power', 'gas the', 'heil hitler', 'sieg heil', 'go back to your country',
];

/** Roots blocked wherever they appear inside a word (no innocent words contain them). */
const BLOCKED_ROOTS = [
  'porn', 'fuck', 'blowjob', 'handjob', 'cumshot', 'onlyfans', 'hentai', 'pussy', 'masturbat',
  'nigger', 'nigga', 'faggot', 'motherf', 'bitch', 'asshole', 'dickhead', 'whore',
  'slut', 'pedophil', 'paedophil', 'wanker', 'tranny',
];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

const TLDS = 'com|net|org|io|co|me|ly|gg|tv|xyz|app|dev|info|biz|ru|de|uk|us|link|site|online|club|live|to|cc|gl|be';
const LINK_PATTERNS = [
  /\b[a-z][a-z0-9+.-]*:\/\//i, // http://, https://, ftp://
  /\bwww\s*\./i,
  new RegExp(`\\b[a-z0-9-]+\\s*(\\.|\\(dot\\)|\\[dot\\]|\\sdot\\s)\\s*(${TLDS})\\b`, 'i'),
  /discord\.gg|t\.me\//i,
];

function normalize(word: string): string {
  return word
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[013457@$!]/g, (c) => LEET[c])
    .replace(/[^a-z]/g, '')
    .replace(/(.)\1{2,}/g, '$1$1'); // "seeexxx" → "seexx"
}

function blockedWord(word: string): boolean {
  if (!word) return false;
  const squeezed = word.replace(/(.)\1+/g, '$1'); // "seex" → "sex"
  return BLOCKED_WORDS.has(word) || BLOCKED_WORDS.has(squeezed) || BLOCKED_ROOTS.some((root) => word.includes(root));
}

/** Why a chat line is refused, or null when it may be sent. */
export function chatRejection(line: string): 'link' | 'word' | null {
  if (LINK_PATTERNS.some((pattern) => pattern.test(line))) return 'link';
  const words = line.split(/[\s,.;:?"'()[\]{}<>/\\|_-]+/).map(normalize);
  if (words.some(blockedWord)) return 'word';
  const joined = ` ${words.filter(Boolean).join(' ')} `;
  if (BLOCKED_PHRASES.some((phrase) => joined.includes(` ${phrase} `) || joined.includes(` ${phrase.replace(/ /g, '')} `))) return 'word';
  // Catch spaced-out spelling such as "s e x" or "p.o.r.n".
  const singles = line.split(/\s+/).map(normalize);
  if (singles.some(blockedWord)) return 'word';
  for (let i = 0; i < singles.length; i++) {
    let run = '';
    for (let j = i; j < singles.length && singles[j].length === 1; j++) {
      run += singles[j];
      if (run.length > 1 && blockedWord(run)) return 'word';
    }
  }
  return null;
}
