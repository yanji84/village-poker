/**
 * Comprehensive integration tests for village-poker.
 * Tests logic, adapter, scenes, and all edge cases.
 *
 * Run: node test.js
 */

import { createDeck, shuffle, evaluateHand, compareHands, determineWinners, formatCards } from './logic.js';
import { initState, phases, tools, onJoin, onLeave } from './adapter.js';
import { waitingScene, bettingScene, showdownScene, finishedScene } from './scene.js';
import { getActivePlayer, dealNewHand, advanceAction, BUY_IN } from './game.js';
import { logAction } from 'agent-village-hub/helpers';

let passed = 0;
let failed = 0;
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n=== ${name} ===`);
}

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL [${currentSection}]: ${msg}`);
  }
}

function assertEq(actual, expected, msg) {
  assert(actual === expected, `${msg}: expected ${expected}, got ${actual}`);
}

function assertIncludes(str, substr, msg) {
  assert(str.includes(substr), `${msg}: expected to include "${substr}"`);
}

// --- Helper: create a fresh game state ---

function freshState() {
  return {
    clock: { tick: 0, phase: 'waiting', roundRobinIndex: 0 },
    bots: [],
    log: [],
    villageCosts: {},
    remoteParticipants: {},
    ...initState({}),
  };
}

function addPlayer(state, name, displayName) {
  displayName = displayName || name.charAt(0).toUpperCase() + name.slice(1);
  const extra = onJoin(state, name, displayName) || {};
  state.bots.push(name);
  state.remoteParticipants[name] = { displayName };
  // Simulate runtime auto-logging of join
  state.log.push({
    bot: name, displayName, action: 'join',
    message: extra.message || `${displayName} joined.`,
    visibility: 'public',
    tick: state.clock.tick, timestamp: new Date().toISOString(),
  });
}

function removePlayer(state, name) {
  const displayName = state.remoteParticipants[name]?.displayName || name;
  const extra = onLeave(state, name, displayName) || {};
  state.bots = state.bots.filter(b => b !== name);
  delete state.remoteParticipants[name];
  // Simulate runtime auto-logging of leave
  state.log.push({
    bot: name, displayName, action: 'leave',
    message: extra.message || `${displayName} left.`,
    visibility: 'public',
    tick: state.clock.tick, timestamp: new Date().toISOString(),
  });
}

function bot(name) {
  return { name, displayName: name.charAt(0).toUpperCase() + name.slice(1) };
}

function dealHand(state) {
  state.clock.phase = 'betting';
  phases.betting.onEnter(state);
}

function totalChips(state) {
  let total = Object.values(state.buyIns).reduce((sum, c) => sum + c, 0);
  // During an active hand (before resolution), chips in the pot are not in buyIns
  if (state.hand && !state.hand.result && state.hand.pot) {
    total += state.hand.pot;
  }
  return total;
}

function playAction(state, botName, toolName, params = {}) {
  return tools[toolName](bot(botName), params, state);
}

// Play through a full hand where everyone calls/checks to showdown
function playToShowdown(state) {
  let safety = 100;
  while (!state.hand.result && safety-- > 0) {
    const active = state.hand.activePlayer;
    if (!active) break;
    const p = state.hand.players[active];
    if (p.bet < state.hand.currentBet) {
      playAction(state, active, 'poker_call');
    } else {
      playAction(state, active, 'poker_check');
    }
  }
  return state.hand.result;
}

// ============================================================
// DECK TESTS
// ============================================================

section('Deck');
{
  const deck = createDeck();
  assertEq(deck.length, 52, 'deck has 52 cards');
  assertEq(new Set(deck).size, 52, 'all unique');

  const s = shuffle(deck);
  assertEq(s.length, 52, 'shuffled has 52');
  assertEq(new Set(s).size, 52, 'shuffled all unique');

  // Shuffle doesn't mutate original
  assert(deck[0] === '2♠', 'original not mutated');
}

// ============================================================
// HAND EVALUATION TESTS
// ============================================================

section('Hand Evaluation — all hand types');
{
  const cases = [
    { cards: ['A♠', 'K♠', 'Q♠', 'J♠', 'T♠', '3♥', '7♦'], name: 'Royal Flush' },
    { cards: ['9♠', '8♠', '7♠', '6♠', '5♠', 'K♥', '2♦'], name: 'Straight Flush' },
    { cards: ['5♣', '4♣', '3♣', '2♣', 'A♣', 'K♥', '9♦'], name: 'Straight Flush' }, // ace-low SF
    { cards: ['A♠', 'A♥', 'A♦', 'A♣', 'K♠', '3♥', '7♦'], name: 'Four of a Kind' },
    { cards: ['A♠', 'A♥', 'A♦', 'K♣', 'K♠', '3♥', '7♦'], name: 'Full House' },
    { cards: ['A♠', 'J♠', '9♠', '7♠', '3♠', 'K♥', '2♦'], name: 'Flush' },
    { cards: ['9♠', '8♥', '7♦', '6♣', '5♠', 'K♥', '2♦'], name: 'Straight' },
    { cards: ['A♠', '2♥', '3♦', '4♣', '5♠', 'K♥', '9♦'], name: 'Straight' }, // ace-low
    { cards: ['A♠', 'K♠', 'Q♠', 'J♠', 'T♥', '3♥', '7♦'], name: 'Straight' }, // ace-high (not flush)
    { cards: ['A♠', 'A♥', 'A♦', '7♣', '3♠', 'K♥', '2♦'], name: 'Three of a Kind' },
    { cards: ['A♠', 'A♥', 'K♦', 'K♣', '3♠', '7♥', '2♦'], name: 'Two Pair' },
    { cards: ['A♠', 'A♥', 'K♦', 'Q♣', '3♠', '7♥', '2♦'], name: 'Pair' },
    { cards: ['A♠', 'K♥', 'Q♦', 'J♣', '9♠', '7♥', '2♦'], name: 'High Card' },
  ];

  for (const { cards, name } of cases) {
    const result = evaluateHand(cards);
    assertEq(result.name, name, `${name} from ${formatCards(cards)}`);
  }
}

section('Hand Evaluation — comparison ordering');
{
  const hands = [
    evaluateHand(['A♠', 'K♠', 'Q♠', 'J♠', 'T♠', '3♥', '7♦']), // royal flush
    evaluateHand(['9♠', '8♠', '7♠', '6♠', '5♠', 'K♥', '2♦']), // straight flush
    evaluateHand(['A♠', 'A♥', 'A♦', 'A♣', 'K♠', '3♥', '7♦']), // four kind
    evaluateHand(['A♠', 'A♥', 'A♦', 'K♣', 'K♠', '3♥', '7♦']), // full house
    evaluateHand(['A♠', 'J♠', '9♠', '7♠', '3♠', 'K♥', '2♦']), // flush
    evaluateHand(['9♠', '8♥', '7♦', '6♣', '5♠', 'K♥', '2♦']), // straight
    evaluateHand(['A♠', 'A♥', 'A♦', '7♣', '3♠', 'K♥', '2♦']), // three kind
    evaluateHand(['A♠', 'A♥', 'K♦', 'K♣', '3♠', '7♥', '2♦']), // two pair
    evaluateHand(['A♠', 'A♥', 'K♦', 'Q♣', '3♠', '7♥', '2♦']), // pair
    evaluateHand(['A♠', 'K♥', 'Q♦', 'J♣', '9♠', '7♥', '2♦']), // high card
  ];

  for (let i = 0; i < hands.length - 1; i++) {
    assert(compareHands(hands[i], hands[i + 1]) > 0,
      `${hands[i].name} > ${hands[i + 1].name}`);
  }
}

section('Hand Evaluation — kicker comparison');
{
  const pairAces = evaluateHand(['A♠', 'A♥', 'K♦', 'Q♣', 'J♠', '3♥', '2♦']);
  const pairKings = evaluateHand(['K♠', 'K♥', 'A♦', 'Q♣', 'J♠', '3♥', '2♦']);
  assert(compareHands(pairAces, pairKings) > 0, 'pair of aces > pair of kings');

  // Same pair, different kicker
  const pairAHighK = evaluateHand(['A♠', 'A♥', 'K♦', '5♣', '3♠', '7♥', '2♦']);
  const pairAHighQ = evaluateHand(['A♠', 'A♥', 'Q♦', '5♣', '3♠', '7♥', '2♦']);
  assert(compareHands(pairAHighK, pairAHighQ) > 0, 'pair aces K kicker > pair aces Q kicker');

  // Identical hands
  const h1 = evaluateHand(['A♠', 'K♥', 'Q♦', 'J♣', '9♠', '3♥', '2♦']);
  const h2 = evaluateHand(['A♦', 'K♣', 'Q♠', 'J♥', '9♦', '4♠', '2♣']);
  assertEq(compareHands(h1, h2), 0, 'identical high cards tie');
}

section('Hand Evaluation — ace-low straight edge cases');
{
  // Ace-low straight should lose to 6-high straight
  const aceLow = evaluateHand(['A♠', '2♥', '3♦', '4♣', '5♠', '8♥', '9♦']);
  const sixHigh = evaluateHand(['2♠', '3♥', '4♦', '5♣', '6♠', '8♥', '9♦']);
  assert(compareHands(sixHigh, aceLow) > 0, '6-high straight > ace-low straight');

  // Ace-low straight flush
  const aceLowSF = evaluateHand(['A♣', '2♣', '3♣', '4♣', '5♣', '8♥', '9♦']);
  assertEq(aceLowSF.name, 'Straight Flush', 'ace-low straight flush detected');
}

section('Hand Evaluation — 5 cards (minimum)');
{
  const fiveCards = evaluateHand(['A♠', 'K♠', 'Q♠', 'J♠', 'T♠']);
  assertEq(fiveCards.name, 'Royal Flush', 'royal flush from exactly 5 cards');
}

section('Hand Evaluation — incomplete hand');
{
  const incomplete = evaluateHand(['A♠', 'K♠', 'Q♠']);
  assertEq(incomplete.name, 'Incomplete', 'less than 5 cards returns Incomplete');
}

// ============================================================
// WINNER DETERMINATION
// ============================================================

section('Winner Determination');
{
  // Clear winner
  const r1 = determineWinners(
    [{ botName: 'a', cards: ['A♠', 'K♠'] }, { botName: 'b', cards: ['2♥', '7♦'] }],
    ['Q♠', 'J♠', 'T♠', '3♣', '4♣']
  );
  assertEq(r1.winners.length, 1, 'one winner');
  assertEq(r1.winners[0], 'a', 'a wins with royal flush');

  // Tie (split pot)
  const r2 = determineWinners(
    [{ botName: 'a', cards: ['2♠', '3♠'] }, { botName: 'b', cards: ['2♥', '3♥'] }],
    ['A♣', 'K♣', 'Q♣', 'J♣', 'T♣']
  );
  assertEq(r2.winners.length, 2, 'two winners (tie — board plays)');

  // Three-way
  const r3 = determineWinners(
    [
      { botName: 'a', cards: ['2♠', '3♠'] },
      { botName: 'b', cards: ['2♥', '3♥'] },
      { botName: 'c', cards: ['2♦', '3♦'] },
    ],
    ['A♣', 'K♣', 'Q♣', 'J♣', 'T♣']
  );
  assertEq(r3.winners.length, 3, 'three-way tie');
}

// ============================================================
// ADAPTER: STATE INITIALIZATION
// ============================================================

section('Adapter — initState');
{
  const s = initState({});
  assert(Array.isArray(s.log), 'log is array');
  assert(typeof s.buyIns === 'object', 'buyIns is object');
  assertEq(s.handsPlayed, 0, 'handsPlayed starts at 0');
}

// ============================================================
// ADAPTER: JOIN / LEAVE
// ============================================================

section('Adapter — onJoin');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  assertEq(state.buyIns.alice, 1000, 'alice gets 1000 chips');
  assertEq(state.bots.length, 1, '1 bot');
  assert(state.log.some(e => e.action === 'join' && e.bot === 'alice'), 'join logged');
}

section('Adapter — onJoin preserves existing chips');
{
  const state = freshState();
  state.buyIns.alice = 500;
  addPlayer(state, 'alice', 'Alice');
  assertEq(state.buyIns.alice, 500, 'existing chips preserved');
}

section('Adapter — onLeave');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  removePlayer(state, 'alice');
  assertEq(state.buyIns.alice, undefined, 'chips removed');
  assert(state.log.some(e => e.action === 'leave' && e.bot === 'alice'), 'leave logged');
}

// ============================================================
// ADAPTER: PHASE TRANSITIONS
// ============================================================

section('Phase Transitions — waiting to betting');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  assert(!phases.waiting.transitions[0].when(state), 'no transition with 1 player');

  addPlayer(state, 'bob', 'Bob');
  assert(phases.waiting.transitions[0].when(state), 'transition fires with 2 players');
}

section('Phase Transitions — showdown to betting');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  // Both have chips — should go to betting (not finished)
  assert(!phases.showdown.transitions[0].when(state), 'not finished when 2 have chips');
  assert(phases.showdown.transitions[1].when(state), 'showdown → betting when 2+ have chips');
}

section('Phase Transitions — showdown to finished (one player left with chips)');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  state.buyIns.bob = 0;
  assert(phases.showdown.transitions[0].when(state), 'finished when 1 player has chips and 2+ at table');
}

section('Phase Transitions — showdown to waiting (not enough players)');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  // Only 1 player at table — not a finish, just waiting for players
  assert(!phases.showdown.transitions[0].when(state), 'not finished with only 1 player at table');
  assert(!phases.showdown.transitions[1].when(state), 'not betting with 1 player');
  assert(phases.showdown.transitions[2].when(state), 'fallback to waiting');
}

// ============================================================
// ADAPTER: DEALING
// ============================================================

section('Dealing — basic hand setup');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  assert(state.hand != null, 'hand exists');
  assertEq(state.hand.seats.length, 2, '2 seats');
  assertEq(state.hand.community.length, 0, 'no community preflop');
  assertEq(state.hand.street, 'preflop', 'street is preflop');
  assert(state.hand.pot > 0, 'pot has blinds');
  assert(state.hand.activePlayer != null, 'active player set');
  assertEq(state.hand.result, null, 'no result yet');

  // Each player has 2 hole cards
  for (const seat of state.hand.seats) {
    assertEq(state.hand.players[seat.botName].cards.length, 2,
      `${seat.botName} has 2 cards`);
  }

  // All cards unique
  const allCards = [];
  for (const p of Object.values(state.hand.players)) allCards.push(...p.cards);
  assertEq(new Set(allCards).size, allCards.length, 'all dealt cards unique');
}

section('Dealing — blinds correct (2 players heads-up)');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  // In heads-up, dealer = SB, other = BB
  const dealerBot = state.hand.seats[state.hand.dealerIndex].botName;
  const otherBot = state.hand.seats.find(s => s.botName !== dealerBot).botName;

  assertEq(state.hand.players[dealerBot].bet, 10, 'dealer posts SB (10)');
  assertEq(state.hand.players[otherBot].bet, 20, 'other posts BB (20)');
  assertEq(state.hand.pot, 30, 'pot = SB + BB');
  assertEq(state.hand.currentBet, 20, 'current bet = BB');

  // First to act is the dealer (SB) in heads-up preflop
  assertEq(state.hand.activePlayer, dealerBot, 'dealer acts first in heads-up');
}

section('Dealing — blinds correct (3 players)');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  addPlayer(state, 'charlie', 'Charlie');
  dealHand(state);

  const seats = state.hand.seats;
  const di = state.hand.dealerIndex;
  const sbIdx = (di + 1) % 3;
  const bbIdx = (di + 2) % 3;

  assertEq(state.hand.players[seats[sbIdx].botName].bet, 10, 'SB posted');
  assertEq(state.hand.players[seats[bbIdx].botName].bet, 20, 'BB posted');
  assertEq(state.hand.pot, 30, 'pot = 30');

  // First to act: after BB (= dealer in 3-player)
  const firstToAct = (bbIdx + 1) % 3;
  assertEq(state.hand.activePlayer, seats[firstToAct].botName, 'UTG acts first');
}

section('Dealing — dealer rotates across hands');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  addPlayer(state, 'charlie', 'Charlie');

  const dealers = [];
  for (let i = 0; i < 6; i++) {
    dealHand(state);
    dealers.push(state.hand.dealerIndex);
    // Quick fold to end hand
    playAction(state, state.hand.activePlayer, 'poker_fold');
  }
  // Dealer should rotate: 0,1,2,0,1,2
  assertEq(dealers[0], 0, 'first dealer is 0');
  assertEq(dealers[1], 1, 'second dealer is 1');
  assertEq(dealers[2], 2, 'third dealer is 2');
  assertEq(dealers[3], 0, 'fourth dealer wraps to 0');
}

section('Dealing — skip players with 0 chips');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  addPlayer(state, 'charlie', 'Charlie');
  state.buyIns.bob = 0;
  dealHand(state);

  assertEq(state.hand.seats.length, 2, 'only 2 seated (bob has 0 chips)');
  assert(!state.hand.players.bob, 'bob not in hand');
}

section('Dealing — not enough players with chips');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  state.buyIns.alice = 0;
  state.buyIns.bob = 0;

  // Manually try dealing
  state.hand = null;
  phases.waiting.onEnter(state);
  assertEq(state.hand, null, 'no hand dealt when nobody has chips');
}

// ============================================================
// ADAPTER: TOOL HANDLERS — BASIC ACTIONS
// ============================================================

section('Tools — poker_check');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  // Active player must call first (facing BB), so check should fail
  if (state.hand.players[active].bet < state.hand.currentBet) {
    const r = playAction(state, active, 'poker_check');
    assertEq(r, null, 'cannot check when facing a bet');
  }
}

section('Tools — poker_call');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  const chipsBefore = state.hand.players[active].chips;
  const potBefore = state.hand.pot;

  const r = playAction(state, active, 'poker_call');
  assert(r != null, 'call returns result');
  assertEq(r.action, 'call', 'action is call');
  assertEq(r.visibility, 'public', 'visibility is public');

  // Chips moved to pot
  const chipsAfter = state.hand.players[active].chips;
  assert(chipsAfter < chipsBefore, 'chips decreased');
  assert(state.hand.pot > potBefore, 'pot increased');
}

section('Tools — poker_raise');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  const r = playAction(state, active, 'poker_raise', { amount: 100 });
  assert(r != null, 'raise returns result');
  assertEq(r.action, 'raise', 'action is raise');
  assertEq(r.amount, 100, 'raise to 100');
  assertEq(state.hand.currentBet, 100, 'current bet updated');
}

section('Tools — poker_raise below minimum');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  // Min raise is max(currentBet * 2, bigBlind) = max(40, 20) = 40
  const r = playAction(state, active, 'poker_raise', { amount: 25 });
  assert(r != null, 'below-min raise treated as min raise');
  assertEq(r.amount, 40, 'adjusted to min raise of 40');
}

section('Tools — poker_raise invalid params');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  assertEq(playAction(state, active, 'poker_raise', {}), null, 'no amount → null');
  assertEq(playAction(state, active, 'poker_raise', { amount: -10 }), null, 'negative amount → null');
  assertEq(playAction(state, active, 'poker_raise', { amount: 'abc' }), null, 'string amount → null');
}

section('Tools — poker_fold');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  const r = playAction(state, active, 'poker_fold');
  assert(r != null, 'fold returns result');
  assertEq(r.action, 'fold', 'action is fold');
  assert(state.hand.players[active].folded, 'player is folded');
}

section('Tools — poker_say');
{
  const state = freshState();
  const r = playAction(state, 'alice', 'poker_say', { message: 'Hello!' });
  assert(r != null, 'say returns result');
  assertEq(r.action, 'say', 'action is say');
  assertEq(r.message, 'Hello!', 'message preserved');

  // Empty message
  assertEq(playAction(state, 'alice', 'poker_say', {}), null, 'no message → null');
  assertEq(playAction(state, 'alice', 'poker_say', { message: '' }), null, 'empty message → null');
}

// ============================================================
// ADAPTER: TOOL GUARDS
// ============================================================

section('Tool Guards — non-active player cannot act');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  const inactive = active === 'alice' ? 'bob' : 'alice';

  assertEq(playAction(state, inactive, 'poker_check'), null, 'inactive cannot check');
  assertEq(playAction(state, inactive, 'poker_call'), null, 'inactive cannot call');
  assertEq(playAction(state, inactive, 'poker_raise', { amount: 100 }), null, 'inactive cannot raise');
  assertEq(playAction(state, inactive, 'poker_fold'), null, 'inactive cannot fold');
}

section('Tool Guards — folded player cannot act');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  addPlayer(state, 'charlie', 'Charlie');
  dealHand(state);

  const active = state.hand.activePlayer;
  playAction(state, active, 'poker_fold');

  // Even if somehow activePlayer, folded player returns null
  state.hand.activePlayer = active; // force
  state.hand.players[active].folded = true;
  assertEq(playAction(state, active, 'poker_check'), null, 'folded cannot check');
  assertEq(playAction(state, active, 'poker_call'), null, 'folded cannot call');
}

section('Tool Guards — no hand state');
{
  const state = freshState();
  state.hand = null;
  assertEq(playAction(state, 'alice', 'poker_check'), null, 'no hand → null');
  assertEq(playAction(state, 'alice', 'poker_call'), null, 'no hand → null');
  assertEq(playAction(state, 'alice', 'poker_fold'), null, 'no hand → null');
  assertEq(playAction(state, 'alice', 'poker_raise', { amount: 100 }), null, 'no hand → null');
}

section('Tool Guards — spectator (joined mid-hand) cannot act');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  // Charlie joins mid-hand
  addPlayer(state, 'charlie', 'Charlie');

  // Force charlie as active (shouldn't happen but test the guard)
  state.hand.activePlayer = 'charlie';
  assertEq(playAction(state, 'charlie', 'poker_check'), null, 'spectator cannot check');
  assertEq(playAction(state, 'charlie', 'poker_call'), null, 'spectator cannot call');
  assertEq(playAction(state, 'charlie', 'poker_raise', { amount: 100 }), null, 'spectator cannot raise');
  assertEq(playAction(state, 'charlie', 'poker_fold'), null, 'spectator cannot fold');
}

// ============================================================
// ADAPTER: FULL HAND FLOWS
// ============================================================

section('Full Hand — everyone folds to one winner');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  addPlayer(state, 'charlie', 'Charlie');
  dealHand(state);

  const initialChips = totalChips(state);

  // Everyone folds except one
  playAction(state, state.hand.activePlayer, 'poker_fold');
  if (!state.hand.result) {
    playAction(state, state.hand.activePlayer, 'poker_fold');
  }

  assert(state.hand.result != null, 'hand resolved');
  assertEq(state.hand.result.winners.length, 1, 'one winner');
  assertEq(state.hand.result.handName, 'Last player standing', 'won by fold');
  assertEq(totalChips(state), initialChips, 'chips conserved');
}

section('Full Hand — call down to showdown (2 players)');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const initialChips = totalChips(state);
  const result = playToShowdown(state);

  assert(result != null, 'hand resolved at showdown');
  assert(result.winners.length >= 1, 'at least one winner');
  assert(['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
    'Flush', 'Full House', 'Four of a Kind', 'Straight Flush', 'Royal Flush']
    .includes(result.handName), `valid hand name: ${result.handName}`);
  assertEq(totalChips(state), initialChips, 'chips conserved');
  assertEq(state.hand.community.length, 5, '5 community cards at showdown');
}

section('Full Hand — call down to showdown (3 players)');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  addPlayer(state, 'charlie', 'Charlie');
  dealHand(state);

  const initialChips = totalChips(state);
  playToShowdown(state);

  assert(state.hand.result != null, 'hand resolved');
  assertEq(totalChips(state), initialChips, 'chips conserved (3 players)');
}

section('Full Hand — raise then call to showdown');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const initialChips = totalChips(state);

  // First player raises
  playAction(state, state.hand.activePlayer, 'poker_raise', { amount: 100 });
  // Play out the rest
  playToShowdown(state);

  assert(state.hand.result != null, 'hand resolved');
  assertEq(totalChips(state), initialChips, 'chips conserved after raise');
}

section('Full Hand — multiple raises');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const initialChips = totalChips(state);

  // Back-and-forth raises
  playAction(state, state.hand.activePlayer, 'poker_raise', { amount: 50 });
  if (state.hand.activePlayer && !state.hand.result) {
    playAction(state, state.hand.activePlayer, 'poker_raise', { amount: 200 });
  }
  // Play out
  playToShowdown(state);

  assert(state.hand.result != null, 'hand resolved');
  assertEq(totalChips(state), initialChips, 'chips conserved after re-raises');
}

section('Full Hand — multiple hands in sequence');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');

  for (let i = 0; i < 10; i++) {
    dealHand(state);
    playToShowdown(state);
    assert(state.hand.result != null, `hand ${i + 1} resolved`);
  }

  assertEq(totalChips(state), 2000, 'chips conserved across 10 hands');
  assertEq(state.handsPlayed, 10, '10 hands played');
}

// ============================================================
// ADAPTER: ALL-IN
// ============================================================

section('All-in — raise exceeds chips');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  state.buyIns.alice = 50; // short stack
  dealHand(state);

  const initialChips = totalChips(state);

  // Alice tries to raise to 1000 but only has ~50 chips
  if (state.hand.activePlayer === 'alice') {
    const r = playAction(state, 'alice', 'poker_raise', { amount: 1000 });
    assert(r != null, 'all-in raise accepted');
    assertEq(state.hand.players.alice.chips, 0, 'alice is all-in');
    assertIncludes(r.message, 'all-in', 'message mentions all-in');
  }
  playToShowdown(state);
  assertEq(totalChips(state), initialChips, 'chips conserved after all-in');
}

section('All-in — call with fewer chips than bet');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  state.buyIns.alice = 100;
  state.buyIns.bob = 1000;
  dealHand(state);

  const initialChips = totalChips(state);

  // Get to a point where alice must call more than she has
  const active = state.hand.activePlayer;
  if (active === 'bob') {
    playAction(state, 'bob', 'poker_raise', { amount: 200 });
    if (state.hand.activePlayer === 'alice' && !state.hand.result) {
      playAction(state, 'alice', 'poker_call');
      assertEq(state.hand.players.alice.chips, 0, 'alice all-in on call');
    }
  }
  playToShowdown(state);
  assertEq(totalChips(state), initialChips, 'chips conserved');
}

section('All-in — blind post with insufficient chips');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  state.buyIns.alice = 5; // less than small blind
  dealHand(state);

  // Alice should have posted whatever she could (5 or less)
  const alicePlayer = state.hand.players.alice;
  assert(alicePlayer.bet <= 5, 'alice posted partial blind');
  assert(alicePlayer.chips >= 0, 'alice chips not negative');

  // Total chips should be conserved (buyIns + pot)
  assertEq(totalChips(state), 1005, 'total chips conserved (5 + 1000)');
}

// ============================================================
// ADAPTER: STREET ADVANCEMENT
// ============================================================

section('Street Advancement — preflop to flop');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  // Both call/check through preflop
  const active = state.hand.activePlayer;
  playAction(state, active, 'poker_call');
  // BB should now be able to check
  if (state.hand.activePlayer && !state.hand.result && state.hand.street === 'preflop') {
    playAction(state, state.hand.activePlayer, 'poker_check');
  }

  if (!state.hand.result) {
    assertEq(state.hand.street, 'flop', 'advanced to flop');
    assertEq(state.hand.community.length, 3, '3 community cards on flop');
    assertEq(state.hand.currentBet, 0, 'bets reset on new street');
  }
}

section('Street Advancement — full progression');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const streets = [];
  let safety = 50;
  while (!state.hand.result && safety-- > 0) {
    if (!streets.includes(state.hand.street)) streets.push(state.hand.street);
    const active = state.hand.activePlayer;
    if (!active) break;
    const p = state.hand.players[active];
    if (p.bet < state.hand.currentBet) {
      playAction(state, active, 'poker_call');
    } else {
      playAction(state, active, 'poker_check');
    }
  }

  assert(streets.includes('preflop'), 'went through preflop');
  assert(state.hand.community.length === 5, '5 community cards');
  assert(state.hand.result != null, 'hand resolved');
}

section('Street Advancement — community cards all unique');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  playToShowdown(state);

  const allCards = [
    ...state.hand.community,
    ...state.hand.players.alice.cards,
    ...state.hand.players.bob.cards,
  ];
  assertEq(new Set(allCards).size, allCards.length, 'all cards in play are unique');
}

// ============================================================
// ADAPTER: LEAVE MID-HAND
// ============================================================

section('Leave Mid-Hand — active player leaves');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  addPlayer(state, 'charlie', 'Charlie');
  dealHand(state);

  const active = state.hand.activePlayer;

  removePlayer(state, active);

  assert(state.hand.players[active].folded, 'leaving player is folded');

  // Hand should continue or resolve
  if (state.hand.result) {
    // Resolved if only 1 left
    assert(true, 'hand resolved after leave');
  } else {
    assert(state.hand.activePlayer !== active, 'active player advanced');
  }
}

section('Leave Mid-Hand — non-active player leaves');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  addPlayer(state, 'charlie', 'Charlie');
  dealHand(state);

  const active = state.hand.activePlayer;
  const inactive = state.hand.seats.find(s =>
    s.botName !== active && !state.hand.players[s.botName].folded
  ).botName;

  removePlayer(state, inactive);
  assert(state.hand.players[inactive].folded, 'leaving player is folded');
  assertEq(state.hand.activePlayer, active, 'active player unchanged');
}

section('Leave Mid-Hand — all but one leave (2 player)');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  removePlayer(state, active);

  assert(state.hand.result != null, 'hand resolved — last player wins');
  assertEq(state.hand.result.winners.length, 1, 'one winner');
}

// ============================================================
// ADAPTER: JOIN MID-HAND
// ============================================================

section('Join Mid-Hand — new player not in current hand');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  addPlayer(state, 'charlie', 'Charlie');
  assert(!state.hand.players.charlie, 'charlie not in hand players');
  assert(!state.hand.seats.find(s => s.botName === 'charlie'), 'charlie not in seats');
  assertEq(state.buyIns.charlie, 1000, 'charlie has chips for next hand');
}

section('Join Mid-Hand — new player dealt in next hand');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  addPlayer(state, 'charlie', 'Charlie');
  playToShowdown(state);

  // Deal next hand
  dealHand(state);
  assert(!!state.hand.players.charlie, 'charlie in next hand');
  assertEq(state.hand.seats.length, 3, '3 seats in next hand');
}

// ============================================================
// ADAPTER: RAISE RE-OPENS ACTION
// ============================================================

section('Raise re-opens action — all must respond');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  addPlayer(state, 'charlie', 'Charlie');
  dealHand(state);

  // First player calls
  const first = state.hand.activePlayer;
  playAction(state, first, 'poker_call');

  // Second player raises
  if (state.hand.activePlayer && !state.hand.result) {
    const second = state.hand.activePlayer;
    playAction(state, second, 'poker_raise', { amount: 100 });

    // Third player and first player should both need to act
    if (!state.hand.result) {
      let actionCount = 0;
      let safety = 10;
      while (state.hand.activePlayer && !state.hand.result && state.hand.street === 'preflop' && safety-- > 0) {
        playAction(state, state.hand.activePlayer, 'poker_call');
        actionCount++;
      }
      assert(actionCount >= 2, `at least 2 players had to respond to raise (got ${actionCount})`);
    }
  }
}

// ============================================================
// ADAPTER: POT SPLIT (TIE)
// ============================================================

section('Pot Split — tied hands');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  // Force identical hands by rigging cards
  state.hand.players.alice.cards = ['2♠', '3♠'];
  state.hand.players.bob.cards = ['2♥', '3♥'];
  // Board that plays: A K Q J T (everyone plays the board)
  state.hand.deck = ['A♣', 'K♣', 'Q♣', 'J♣', 'T♣', '9♣', '8♣', '7♣', '6♣', '5♣'];

  const initialChips = totalChips(state);
  playToShowdown(state);

  assertEq(state.hand.result.winners.length, 2, 'two winners (tie)');
  assertEq(totalChips(state), initialChips, 'chips conserved in split pot');
}

// ============================================================
// ADAPTER: CHECK-THEN-CALL AFTER BEING CHECKED INTO
// ============================================================

section('Check then bet — BB checks, post-flop action');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  // SB calls (heads-up, dealer = SB acts first preflop)
  playAction(state, state.hand.activePlayer, 'poker_call');
  // BB checks
  if (state.hand.activePlayer && !state.hand.result && state.hand.street === 'preflop') {
    playAction(state, state.hand.activePlayer, 'poker_check');
  }

  // Now on flop — first to act should be non-dealer
  if (!state.hand.result) {
    assertEq(state.hand.street, 'flop', 'on flop');
    // Post-flop, action starts after dealer
    const dealerBot = state.hand.seats[state.hand.dealerIndex].botName;
    assert(state.hand.activePlayer !== dealerBot || state.hand.seats.length === 2,
      'post-flop action starts correctly');
  }
}

// ============================================================
// SCENE TESTS
// ============================================================

section('Scenes — waiting scene');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');

  const scene = waitingScene(bot('alice'), { allBots: [], state, worldConfig: {}, phase: 'waiting', log: [] });
  assertIncludes(scene, 'Waiting for players', 'shows waiting');
  assertIncludes(scene, 'Players at the table: 1', 'shows count');
}

section('Scenes — betting scene with hole cards');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const ctx = { allBots: [], state, worldConfig: { sceneLabels: {} }, phase: 'betting', log: state.log };

  // Alice sees her own cards
  const aliceScene = bettingScene(bot('alice'), ctx);
  const aliceCards = state.hand.players.alice.cards;
  assertIncludes(aliceScene, aliceCards[0], 'alice sees her first card');
  assertIncludes(aliceScene, aliceCards[1], 'alice sees her second card');

  // Alice should NOT see Bob's cards
  const bobCards = state.hand.players.bob.cards;
  assert(!aliceScene.includes(bobCards[0]) || aliceCards.includes(bobCards[0]),
    'alice does not see bob card 1 (unless same card — extremely unlikely)');
}

section('Scenes — betting scene for spectator');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  addPlayer(state, 'charlie', 'Charlie');

  const ctx = { allBots: [], state, worldConfig: { sceneLabels: {} }, phase: 'betting', log: state.log };
  const scene = bettingScene(bot('charlie'), ctx);
  assertIncludes(scene, 'mid-hand', 'spectator sees mid-hand message');
  assertIncludes(scene, 'next hand', 'spectator told about next hand');
}

section('Scenes — betting scene for folded player');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  addPlayer(state, 'charlie', 'Charlie');
  dealHand(state);

  const active = state.hand.activePlayer;
  playAction(state, active, 'poker_fold');

  const ctx = { allBots: [], state, worldConfig: { sceneLabels: {} }, phase: 'betting', log: state.log };
  const scene = bettingScene(bot(active), ctx);
  assertIncludes(scene, 'folded', 'folded player sees fold message');
}

section('Scenes — betting scene shows active player');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  const ctx = { allBots: [], state, worldConfig: { sceneLabels: {} }, phase: 'betting', log: state.log };
  const scene = bettingScene(bot(active), ctx);
  assertIncludes(scene, 'Your turn', 'active player sees turn prompt');
}

section('Scenes — betting scene shows correct options');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  const p = state.hand.players[active];
  const ctx = { allBots: [], state, worldConfig: { sceneLabels: {} }, phase: 'betting', log: state.log };
  const scene = bettingScene(bot(active), ctx);

  if (p.bet < state.hand.currentBet) {
    assertIncludes(scene, 'poker_call', 'facing bet → shows call option');
    assert(!scene.includes('poker_check') || scene.includes('poker_call'),
      'facing bet → does not show check as primary');
  } else {
    assertIncludes(scene, 'poker_check', 'no bet → shows check option');
  }
}

section('Scenes — showdown scene');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);
  playToShowdown(state);

  const ctx = { allBots: [], state, worldConfig: { sceneLabels: {} }, phase: 'showdown', log: state.log };
  const scene = showdownScene(bot('alice'), ctx);
  assertIncludes(scene, 'Showdown', 'shows Showdown');
  assertIncludes(scene, 'Winner', 'shows winner');
  assertIncludes(scene, 'Board', 'shows board');
}

section('Scenes — community cards on flop');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  // Play through preflop
  playAction(state, state.hand.activePlayer, 'poker_call');
  if (state.hand.activePlayer && !state.hand.result && state.hand.street === 'preflop') {
    playAction(state, state.hand.activePlayer, 'poker_check');
  }

  if (!state.hand.result && state.hand.street === 'flop') {
    const ctx = { allBots: [], state, worldConfig: { sceneLabels: {} }, phase: 'betting', log: state.log };
    const scene = bettingScene(bot('alice'), ctx);
    assertIncludes(scene, 'Board:', 'flop shows board');
    assertIncludes(scene, 'Flop', 'shows Flop label');
  }
}

// ============================================================
// EDGE CASES
// ============================================================

section('Edge — call when nothing to call (should be null)');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  // Get to a state where active player has already matched
  // Play through preflop to flop
  playAction(state, state.hand.activePlayer, 'poker_call');
  if (state.hand.activePlayer && !state.hand.result && state.hand.street === 'preflop') {
    playAction(state, state.hand.activePlayer, 'poker_check');
  }

  // On flop, currentBet = 0, player bet = 0 → toCall = 0 → call returns null
  if (!state.hand.result && state.hand.activePlayer) {
    const active = state.hand.activePlayer;
    const r = playAction(state, active, 'poker_call');
    assertEq(r, null, 'call with nothing to call returns null');
  }
}

section('Edge — rapid fold sequence (3 players, 2 fold)');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  addPlayer(state, 'charlie', 'Charlie');
  dealHand(state);

  const initialChips = totalChips(state);

  playAction(state, state.hand.activePlayer, 'poker_fold');
  if (!state.hand.result) {
    playAction(state, state.hand.activePlayer, 'poker_fold');
  }

  assert(state.hand.result != null, 'hand resolved after 2 folds');
  assertEq(state.hand.result.winners.length, 1, 'one winner');
  assertEq(totalChips(state), initialChips, 'chips conserved');
}

section('Edge — single player with chips after hand');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  state.buyIns.bob = 20; // Bob can only afford one blind
  dealHand(state);

  // Play to completion
  playToShowdown(state);

  // One player may be busted — game should end
  const playersWithChips = state.bots.filter(b => (state.buyIns[b] || 0) > 0);
  if (playersWithChips.length < 2) {
    assert(phases.showdown.transitions[0].when(state), 'transitions to finished');
    assert(!phases.showdown.transitions[1].when(state), 'does not transition to betting');
  }
}

section('Edge — 6-player table');
{
  const state = freshState();
  const names = ['alice', 'bob', 'charlie', 'dave', 'eve', 'frank'];
  for (const n of names) addPlayer(state, n, n.charAt(0).toUpperCase() + n.slice(1));
  dealHand(state);

  assertEq(state.hand.seats.length, 6, '6 seats');
  assertEq(state.hand.pot, 30, 'blinds posted');

  const initialChips = totalChips(state);

  // Everyone folds to BB
  let safety = 10;
  while (state.hand.activePlayer && !state.hand.result && safety-- > 0) {
    playAction(state, state.hand.activePlayer, 'poker_fold');
  }

  assert(state.hand.result != null, '6-player hand resolved');
  assertEq(totalChips(state), initialChips, '6-player chips conserved');
}

section('Edge — check-check through entire hand (heads-up)');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  // Preflop: SB calls, BB checks
  playAction(state, state.hand.activePlayer, 'poker_call');
  if (state.hand.activePlayer && state.hand.street === 'preflop' && !state.hand.result) {
    playAction(state, state.hand.activePlayer, 'poker_check');
  }

  // Flop/Turn/River: both check
  let safety = 20;
  while (state.hand.activePlayer && !state.hand.result && safety-- > 0) {
    playAction(state, state.hand.activePlayer, 'poker_check');
  }

  assert(state.hand.result != null, 'check-check hand resolved');
  assertEq(state.hand.community.length, 5, '5 community cards');
}

section('Edge — multiple hands drain a player to 0');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  state.buyIns.bob = 100; // short stack

  let safety = 50;
  while (state.buyIns.bob > 0 && state.buyIns.alice > 0 && safety-- > 0) {
    dealHand(state);
    playToShowdown(state);
  }

  const total = (state.buyIns.alice || 0) + (state.buyIns.bob || 0);
  assertEq(total, 2000 - 1000 + 100, 'total chips correct (1100)');
  assert(state.buyIns.alice === 0 || state.buyIns.bob === 0 || safety <= 0,
    'one player busted or hit safety limit');
}

section('Edge — onLeave cleans up buyIns');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  removePlayer(state, 'alice');
  assertEq(state.buyIns.alice, undefined, 'buyIns cleaned up on leave');
}

section('Edge — rejoin after leaving gets new buy-in');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  removePlayer(state, 'alice');
  addPlayer(state, 'alice', 'Alice');
  assertEq(state.buyIns.alice, 1000, 'new buy-in on rejoin');
}

section('Edge — poker_say works in any phase');
{
  const state = freshState();
  // No hand, no nothing
  const r = tools.poker_say(bot('alice'), { message: 'hi' }, state);
  assert(r != null, 'say works without active hand');
  assertEq(r.visibility, 'public', 'say is public');
}

section('Edge — chip conservation across many random hands');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  addPlayer(state, 'charlie', 'Charlie');

  const initialChips = totalChips(state);

  for (let i = 0; i < 20; i++) {
    const playersWithChips = state.bots.filter(b => (state.buyIns[b] || 0) > 0);
    if (playersWithChips.length < 2) break;

    dealHand(state);

    // Random actions
    let safety = 30;
    while (state.hand.activePlayer && !state.hand.result && safety-- > 0) {
      const active = state.hand.activePlayer;
      const rand = Math.random();
      if (rand < 0.3) {
        playAction(state, active, 'poker_fold');
      } else if (rand < 0.5) {
        const r = playAction(state, active, 'poker_raise', { amount: state.hand.currentBet * 2 + 20 });
        if (!r) playAction(state, active, 'poker_call') || playAction(state, active, 'poker_check');
      } else {
        const r = playAction(state, active, 'poker_call');
        if (!r) playAction(state, active, 'poker_check');
      }
    }
  }

  assertEq(totalChips(state), initialChips, 'chips conserved across 20 random hands');
}

// ============================================================
// FINISHED PHASE — game ending
// ============================================================

section('Finished — onEnter sets winner state');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  state.buyIns.alice = 2000;
  state.buyIns.bob = 0;
  state.handsPlayed = 15;

  phases.finished.onEnter(state);
  assert(state.winner != null, 'winner state set');
  assertEq(state.winner.botName, 'alice', 'winner is alice');
  assertEq(state.winner.displayName, 'Alice', 'winner display name');
  assertEq(state.winner.chips, 2000, 'winner chips');
  assertEq(state.winner.handsPlayed, 15, 'hands played recorded');
  assert(state.log.some(e => e.action === 'game_over'), 'game_over logged');
}

section('Finished — transitions to waiting when winner leaves');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  state.buyIns.alice = 2000;
  state.buyIns.bob = 0;

  // Game is finished — 1 player with chips, 2 at table
  assert(!phases.finished.transitions[0].when(state), 'stays in finished');

  // Alice leaves — no longer 1 winner at the table
  removePlayer(state, 'alice');
  assert(phases.finished.transitions[0].when(state), 'transitions to waiting after winner leaves');
}

section('Finished — transitions to waiting when new player joins');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  state.buyIns.alice = 2000;
  state.buyIns.bob = 0;

  // Remove bob (busted), now only 1 player at table
  removePlayer(state, 'bob');
  assert(phases.finished.transitions[0].when(state), 'transitions when <2 players at table');
}

section('Finished — full game: play until one player wins');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');

  // Bob folds every hand — alice wins blinds each time until bob is busted
  let safety = 200;
  while (safety-- > 0) {
    dealHand(state);
    if (!state.hand) break;

    // Bob folds if active, alice calls/checks
    const active = state.hand.activePlayer;
    if (active === 'bob') {
      playAction(state, 'bob', 'poker_fold');
    } else {
      playAction(state, 'alice', 'poker_call');
      if (state.hand.activePlayer === 'bob' && !state.hand.result) {
        playAction(state, 'bob', 'poker_fold');
      }
    }

    const playersWithChips = state.bots.filter(b => (state.buyIns[b] || 0) > 0);
    if (playersWithChips.length <= 1) break;
  }

  const playersWithChips = state.bots.filter(b => (state.buyIns[b] || 0) > 0);
  assertEq(playersWithChips.length, 1, 'one player has all chips');

  const winner = playersWithChips[0];
  assertEq(state.buyIns[winner], 2000, 'winner has total buy-in amount');

  // Verify finished transition would fire
  assert(phases.showdown.transitions[0].when(state), 'showdown → finished fires');
}

section('Finished — no auto-rebuy of busted players');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  state.buyIns.bob = 0;

  // Trigger waiting transition — should NOT rebuy bob
  phases.waiting.transitions[0].when(state);
  assertEq(state.buyIns.bob, 0, 'busted player not rebuyed');
}

section('Finished scene — shows winner and standings');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  state.buyIns.alice = 2000;
  state.buyIns.bob = 0;
  state.winner = { botName: 'alice', displayName: 'Alice', chips: 2000, handsPlayed: 10 };

  const ctx = { allBots: [bot('alice'), bot('bob')], state, worldConfig: { sceneLabels: {}, raw: {} }, phase: 'finished', log: [] };
  const scene = finishedScene(bot('alice'), ctx);
  assertIncludes(scene, 'Game Over', 'scene shows game over');
  assertIncludes(scene, 'Alice', 'scene shows winner name');
  assertIncludes(scene, '2000', 'scene shows winner chips');
}

// ============================================================
// GAME.JS — getActivePlayer guard
// ============================================================

section('getActivePlayer — returns hand and player for active bot');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  const result = getActivePlayer(state, bot(active));
  assert(result !== null, 'returns non-null for active player');
  assertEq(result.hand, state.hand, 'returns the hand');
  assert(result.player !== undefined, 'returns the player');
  assertEq(result.player.folded, false, 'player not folded');
}

section('getActivePlayer — returns null for non-active bot');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  const other = active === 'alice' ? 'bob' : 'alice';
  const result = getActivePlayer(state, bot(other));
  assertEq(result, null, 'null for non-active bot');
}

section('getActivePlayer — returns null when no hand');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  const result = getActivePlayer(state, bot('alice'));
  assertEq(result, null, 'null when no hand exists');
}

section('getActivePlayer — returns null for folded player');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  // Fold the active player manually
  state.hand.players[active].folded = true;
  const result = getActivePlayer(state, bot(active));
  assertEq(result, null, 'null for folded player');
}

// ============================================================
// GAME.JS — logAction helper
// ============================================================

section('logAction — stamps tick and timestamp');
{
  const state = freshState();
  state.clock.tick = 42;
  logAction(state, { action: 'test', message: 'hello', visibility: 'public' });

  const entry = state.log[state.log.length - 1];
  assertEq(entry.action, 'test', 'action preserved');
  assertEq(entry.message, 'hello', 'message preserved');
  assertEq(entry.tick, 42, 'tick stamped from state.clock');
  assert(typeof entry.timestamp === 'string', 'timestamp is a string');
  assert(entry.timestamp.includes('T'), 'timestamp is ISO format');
}

section('logAction — does not overwrite explicit fields');
{
  const state = freshState();
  state.clock.tick = 5;
  logAction(state, { action: 'deal', bot: 'dealer', displayName: 'Dealer', visibility: 'public' });

  const entry = state.log[state.log.length - 1];
  assertEq(entry.bot, 'dealer', 'bot field preserved');
  assertEq(entry.displayName, 'Dealer', 'displayName preserved');
}

// ============================================================
// GAME.JS — direct imports
// ============================================================

section('game.js — BUY_IN export');
{
  assertEq(BUY_IN, 1000, 'BUY_IN is 1000');
}

section('game.js — dealNewHand works independently');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  const result = dealNewHand(state);
  assertEq(result, true, 'deals successfully with 2 players');
  assert(state.hand !== undefined, 'hand state created');
  assertEq(state.hand.seats.length, 2, '2 seats');
  assert(state.hand.activePlayer !== null, 'active player set');
}

section('game.js — dealNewHand fails with < 2 players');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  const result = dealNewHand(state);
  assertEq(result, false, 'fails with 1 player');
}

// ============================================================
// ADAPTER — onJoin/onLeave don't log (runtime handles it)
// ============================================================

section('onJoin — returns message but does not push to log');
{
  const state = freshState();
  const logBefore = state.log.length;
  const result = onJoin(state, 'alice', 'Alice');

  assert(result.message !== undefined, 'returns a message');
  assert(result.message.includes('Alice'), 'message includes display name');
  assertEq(state.log.length, logBefore, 'log unchanged — runtime handles logging');
  assertEq(state.buyIns.alice, 1000, 'chips still set');
}

section('onLeave — returns message but does not push to log');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  const logBefore = state.log.length;
  const result = onLeave(state, 'alice', 'Alice');

  assert(result.message !== undefined, 'returns a message');
  assert(result.message.includes('Alice'), 'message includes display name');
  assertEq(state.log.length, logBefore, 'log unchanged — runtime handles logging');
  assertEq(state.buyIns.alice, undefined, 'chips cleaned up');
}

// ============================================================
// TOOL HANDLERS — thought pass-through
// ============================================================

section('poker_check — includes thought when provided');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  // Find and set up a player who can check (BB after everyone calls)
  const active = state.hand.activePlayer;
  // Call first so next player can check
  playAction(state, active, 'poker_call');

  const nextActive = state.hand.activePlayer;
  if (nextActive) {
    const result = playAction(state, nextActive, 'poker_check', { thought: 'testing thoughts' });
    if (result) {
      assertEq(result.thought, 'testing thoughts', 'thought field included in return');
      assertEq(result.action, 'check', 'action is still check');
    }
  }
}

section('poker_fold — includes thought when provided');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  const result = playAction(state, active, 'poker_fold', { thought: 'I should fold' });
  assert(result !== null, 'fold returns result');
  assertEq(result.thought, 'I should fold', 'thought on fold');
}

section('poker_call — includes thought when provided');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  const result = playAction(state, active, 'poker_call', { thought: 'pot odds are good' });
  assert(result !== null, 'call returns result');
  assertEq(result.thought, 'pot odds are good', 'thought on call');
}

section('poker_raise — includes thought when provided');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  const result = playAction(state, active, 'poker_raise', { amount: 40, thought: 'strong hand' });
  assert(result !== null, 'raise returns result');
  assertEq(result.thought, 'strong hand', 'thought on raise');
}

section('poker_check — no thought field when not provided');
{
  const state = freshState();
  addPlayer(state, 'alice', 'Alice');
  addPlayer(state, 'bob', 'Bob');
  dealHand(state);

  const active = state.hand.activePlayer;
  playAction(state, active, 'poker_call');

  const nextActive = state.hand.activePlayer;
  if (nextActive) {
    const result = playAction(state, nextActive, 'poker_check', {});
    if (result) {
      assert(!('thought' in result), 'no thought field when not provided');
    }
  }
}

// ============================================================
// RESULTS
// ============================================================

console.log(`\n${'='.repeat(50)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailed tests are listed above.');
}
process.exit(failed > 0 ? 1 : 0);
