/**
 * Local question detection. No API call, no model — pure string work, so it
 * costs nothing and cannot add latency to the transcript path.
 *
 * Every rejection is returned with a reason and logged, because the rules below
 * are meant to be tuned from real call transcripts rather than guessed at.
 *
 * Known false-positive surface, kept deliberately: leading `is/are/do/does/did/
 * can` matches real questions ("Do we have the numbers?") but also call noise
 * ("Can you hear me", "Are you there"). Those burn rate limit. The console log
 * is how you find them.
 */

const INTERROGATIVE_WORDS = [
  'what',
  'where',
  'who',
  'whom',
  'whose',
  'when',
  'which',
  'how',
  'why',
  'is',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'will',
];

/** Multi-word openers that signal a request for a fact. */
const INTERROGATIVE_PHRASES = ['name the', 'tell me', 'list the', 'give me'];

const SUPERLATIVES = [
  'biggest',
  'highest',
  'largest',
  'tallest',
  'longest',
  'smallest',
  'shortest',
  'first',
  'last',
  'fastest',
  'slowest',
  'oldest',
  'newest',
  'best',
  'worst',
  'most',
  'least',
];

export const MIN_WORDS = 4;
export const MAX_WORDS = 30;
/** Minimum gap between two accepted segments. */
export const COOLDOWN_MS = 2000;

export type RejectReason =
  | 'empty'
  | 'too-short'
  | 'too-long'
  | 'not-a-question'
  | 'cooldown';

export interface FilterAccepted {
  accepted: true;
  question: string;
  matched: string;
}

export interface FilterRejected {
  accepted: false;
  reason: RejectReason;
  detail: string;
}

export type FilterResult = FilterAccepted | FilterRejected;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * @param text        candidate segment
 * @param lastAccepted epoch ms of the previously accepted segment, 0 if none
 * @param now          injectable clock, for tests
 */
export function classify(text: string, lastAccepted: number, now = Date.now()): FilterResult {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { accepted: false, reason: 'empty', detail: 'blank segment' };

  const tokens = words(trimmed);
  if (tokens.length < MIN_WORDS) {
    return {
      accepted: false,
      reason: 'too-short',
      detail: `${tokens.length} words (minimum ${MIN_WORDS})`,
    };
  }
  if (tokens.length > MAX_WORDS) {
    return {
      accepted: false,
      reason: 'too-long',
      detail: `${tokens.length} words (maximum ${MAX_WORDS})`,
    };
  }

  const lowered = trimmed.toLowerCase();
  let matched = '';

  if (trimmed.endsWith('?')) {
    matched = 'ends with ?';
  } else if (INTERROGATIVE_PHRASES.some((phrase) => lowered.startsWith(phrase))) {
    matched = `opens with "${INTERROGATIVE_PHRASES.find((p) => lowered.startsWith(p))}"`;
  } else if (INTERROGATIVE_WORDS.includes(tokens[0]!)) {
    matched = `opens with "${tokens[0]}"`;
  } else {
    // Superlative + noun: the superlative must be followed by another word, so
    // "that was the best" does not qualify but "the best selling phone" does.
    const index = tokens.findIndex((token) => SUPERLATIVES.includes(token));
    if (index !== -1 && index < tokens.length - 1) {
      matched = `superlative "${tokens[index]} ${tokens[index + 1]}"`;
    }
  }

  if (!matched) {
    return {
      accepted: false,
      reason: 'not-a-question',
      detail: 'no question mark, interrogative opener or superlative pattern',
    };
  }

  // Cooldown is checked last so the log shows *why* an otherwise valid question
  // was dropped, rather than hiding it behind the cheaper checks.
  const sinceLast = now - lastAccepted;
  if (lastAccepted > 0 && sinceLast < COOLDOWN_MS) {
    return {
      accepted: false,
      reason: 'cooldown',
      detail: `${sinceLast} ms since last accepted (minimum ${COOLDOWN_MS} ms)`,
    };
  }

  return { accepted: true, question: trimmed, matched };
}

/**
 * Do two transcriptions of the same segment differ enough to be worth
 * re-issuing the request? Punctuation and casing changes between the interim
 * and the final are normal and must not cancel an in-flight answer.
 */
export function materiallyDifferent(interim: string, final: string): boolean {
  const a = words(interim);
  const b = words(final);
  if (a.length === 0) return b.length > 0;

  // Same words in the same order, ignoring a trailing tail the interim had not
  // heard yet, counts as the same question.
  const shared = Math.min(a.length, b.length);
  let same = 0;
  for (let i = 0; i < shared; i += 1) {
    if (a[i] === b[i]) same += 1;
  }
  const overlap = same / Math.max(a.length, b.length);
  return overlap < 0.8;
}
