/**
 * Poker logic — deck, dealing, hand evaluation, pot calculation.
 * Pure functions, no side effects.
 */

// --- Deck ---

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i + 2])); // 2=2 .. A=14

export function createDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push(r + s);
    }
  }
  return deck;
}

export function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export function cardRank(card) { return card[0]; }
export function cardSuit(card) { return card.slice(1); }
export function rankValue(card) { return RANK_VALUE[cardRank(card)]; }

export function formatCard(card) { return card; }
export function formatCards(cards) { return cards.join(' '); }

// --- Hand evaluation ---

// Hand ranks (higher = better)
const HAND_RANKS = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  THREE_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_KIND: 7,
  STRAIGHT_FLUSH: 8,
  ROYAL_FLUSH: 9,
};

const HAND_NAMES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind',
  'Straight', 'Flush', 'Full House', 'Four of a Kind',
  'Straight Flush', 'Royal Flush',
];

/**
 * Evaluate the best 5-card hand from 7 cards (2 hole + 5 community).
 * Returns { rank, kickers, name, bestCards }
 */
export function evaluateHand(cards) {
  if (cards.length < 5) return { rank: -1, kickers: [], name: 'Incomplete', bestCards: cards };

  let best = null;
  const combos = combinations(cards, 5);

  for (const combo of combos) {
    const result = evaluate5(combo);
    if (!best || compareHands(result, best) > 0) {
      best = { ...result, bestCards: combo };
    }
  }

  return best;
}

function evaluate5(cards) {
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const suits = cards.map(cardSuit);

  const isFlush = suits.every(s => s === suits[0]);

  // Check straight (including ace-low)
  let isStraight = false;
  let straightHigh = 0;
  if (values[0] - values[4] === 4 && new Set(values).size === 5) {
    isStraight = true;
    straightHigh = values[0];
  }
  // Ace-low straight: A-2-3-4-5
  if (values[0] === 14 && values[1] === 5 && values[2] === 4 && values[3] === 3 && values[4] === 2) {
    isStraight = true;
    straightHigh = 5; // 5-high straight
  }

  // Count ranks
  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([v, c]) => ({ value: parseInt(v), count: c }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  if (isFlush && isStraight) {
    const rank = straightHigh === 14 ? HAND_RANKS.ROYAL_FLUSH : HAND_RANKS.STRAIGHT_FLUSH;
    return { rank, kickers: [straightHigh], name: HAND_NAMES[rank] };
  }
  if (groups[0].count === 4) {
    return { rank: HAND_RANKS.FOUR_KIND, kickers: [groups[0].value, groups[1].value], name: HAND_NAMES[HAND_RANKS.FOUR_KIND] };
  }
  if (groups[0].count === 3 && groups[1].count === 2) {
    return { rank: HAND_RANKS.FULL_HOUSE, kickers: [groups[0].value, groups[1].value], name: HAND_NAMES[HAND_RANKS.FULL_HOUSE] };
  }
  if (isFlush) {
    return { rank: HAND_RANKS.FLUSH, kickers: values, name: HAND_NAMES[HAND_RANKS.FLUSH] };
  }
  if (isStraight) {
    return { rank: HAND_RANKS.STRAIGHT, kickers: [straightHigh], name: HAND_NAMES[HAND_RANKS.STRAIGHT] };
  }
  if (groups[0].count === 3) {
    const kickers = groups.slice(1).map(g => g.value);
    return { rank: HAND_RANKS.THREE_KIND, kickers: [groups[0].value, ...kickers], name: HAND_NAMES[HAND_RANKS.THREE_KIND] };
  }
  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairValues = [groups[0].value, groups[1].value].sort((a, b) => b - a);
    return { rank: HAND_RANKS.TWO_PAIR, kickers: [...pairValues, groups[2].value], name: HAND_NAMES[HAND_RANKS.TWO_PAIR] };
  }
  if (groups[0].count === 2) {
    const kickers = groups.slice(1).map(g => g.value).sort((a, b) => b - a);
    return { rank: HAND_RANKS.PAIR, kickers: [groups[0].value, ...kickers], name: HAND_NAMES[HAND_RANKS.PAIR] };
  }
  return { rank: HAND_RANKS.HIGH_CARD, kickers: values, name: HAND_NAMES[HAND_RANKS.HIGH_CARD] };
}

/**
 * Compare two evaluated hands. Returns positive if a > b, negative if a < b, 0 if tie.
 */
export function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.max(a.kickers.length, b.kickers.length); i++) {
    const ak = a.kickers[i] || 0;
    const bk = b.kickers[i] || 0;
    if (ak !== bk) return ak - bk;
  }
  return 0;
}

/**
 * Determine winners from a list of { botName, cards } given community cards.
 * Returns { winners: [botName], handName, pot }
 */
export function determineWinners(players, communityCards) {
  const evaluated = players.map(p => ({
    botName: p.botName,
    hand: evaluateHand([...p.cards, ...communityCards]),
  }));

  evaluated.sort((a, b) => compareHands(b.hand, a.hand));
  const bestRank = evaluated[0].hand;
  const winners = evaluated.filter(e => compareHands(e.hand, bestRank) === 0);

  return {
    winners: winners.map(w => w.botName),
    handName: bestRank.name,
    evaluations: evaluated.map(e => ({ botName: e.botName, hand: e.hand.name, bestCards: e.hand.bestCards })),
  };
}

// --- Utilities ---

function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const result = [];
  const [first, ...rest] = arr;
  for (const combo of combinations(rest, k - 1)) {
    result.push([first, ...combo]);
  }
  result.push(...combinations(rest, k));
  return result;
}
