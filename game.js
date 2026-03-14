/**
 * Poker game engine — hand flow, betting, and resolution.
 *
 * Pure state-machine logic: takes state, mutates it, returns result.
 * No adapter interface, no hub knowledge.
 */

import { createDeck, shuffle, determineWinners, formatCards } from './logic.js';
import { logAction } from 'agent-village-hub/helpers';

// --- Config ---

export const BUY_IN = 1000;
export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;

// --- Active player guard ---

/**
 * Validate that the bot is the current active player and not folded.
 * Returns { hand, player } or null if the bot cannot act.
 */
export function getActivePlayer(state, bot) {
  const hand = state.hand;
  if (!hand || hand.activePlayer !== bot.name) return null;
  const player = hand.players[bot.name];
  if (!player || player.folded) return null;
  return { hand, player };
}

// --- Hand management ---

export function dealNewHand(state) {
  const bots = state.bots.filter(b => (state.buyIns[b] || 0) > 0);
  if (bots.length < 2) return false;

  const deck = shuffle(createDeck());
  const seats = bots.map(b => ({
    botName: b,
    displayName: state.remoteParticipants[b]?.displayName || b,
  }));

  // Advance dealer
  const prevDealer = state.hand?.dealerIndex ?? -1;
  const dealerIndex = (prevDealer + 1) % seats.length;

  // Deal hole cards
  const players = {};
  for (const seat of seats) {
    const cards = [deck.pop(), deck.pop()];
    players[seat.botName] = {
      cards,
      chips: state.buyIns[seat.botName],
      bet: 0,
      totalBet: 0,
      folded: false,
      acted: false,
    };
  }

  // Set up hand state
  state.hand = {
    seats,
    players,
    dealerIndex,
    deck,
    community: [],
    pot: 0,
    currentBet: 0,
    bigBlind: BIG_BLIND,
    street: 'preflop',
    activePlayer: null,
    actedCount: 0,
    result: null,
    startTick: state.clock.tick,
  };

  // Log hole cards (private per player — observer sees via SSE, bots don't)
  for (const seat of seats) {
    logAction(state, {
      bot: seat.botName,
      displayName: seat.displayName,
      action: 'deal_hole',
      cards: players[seat.botName].cards.slice(),
      message: `is dealt ${formatCards(players[seat.botName].cards)}`,
      visibility: 'private',
    });
  }

  // Post blinds
  const sbIndex = seats.length === 2 ? dealerIndex : (dealerIndex + 1) % seats.length;
  const bbIndex = (sbIndex + 1) % seats.length;

  postBlind(state, seats[sbIndex].botName, SMALL_BLIND, 'small');
  postBlind(state, seats[bbIndex].botName, BIG_BLIND, 'big');

  state.hand.currentBet = BIG_BLIND;

  // First to act: after BB in preflop
  const firstToAct = (bbIndex + 1) % seats.length;
  state.hand.activePlayer = seats[firstToAct].botName;
  state.hand.activePlayerDispatched = false;

  // Reset acted flags (blinds don't count as acting)
  for (const p of Object.values(state.hand.players)) {
    p.acted = false;
  }

  state.handsPlayed++;

  return true;
}

function postBlind(state, botName, amount, type) {
  const p = state.hand.players[botName];
  const actual = Math.min(amount, p.chips);
  p.chips -= actual;
  p.bet += actual;
  p.totalBet += actual;
  state.hand.pot += actual;
  state.buyIns[botName] = p.chips;

  const seat = state.hand.seats.find(s => s.botName === botName);
  logAction(state, {
    bot: botName,
    displayName: seat?.displayName || botName,
    action: 'blind',
    blindType: type,
    amount: actual,
    message: `posts ${type} blind (${actual})`,
    visibility: 'public',
  });
}

export function advanceAction(state) {
  const hand = state.hand;
  const seats = hand.seats;
  const activePlayers = seats.filter(s => !hand.players[s.botName].folded);

  // One player left — they win
  if (activePlayers.length === 1) {
    resolveHand(state, activePlayers);
    return 'showdown';
  }

  // Find next non-folded player who hasn't acted (or needs to match a raise)
  const currentIndex = seats.findIndex(s => s.botName === hand.activePlayer);
  for (let i = 1; i <= seats.length; i++) {
    const idx = (currentIndex + i) % seats.length;
    const seat = seats[idx];
    const p = hand.players[seat.botName];
    if (p.folded) continue;
    if (!p.acted || p.bet < hand.currentBet) {
      hand.activePlayer = seat.botName;
      hand.activePlayerDispatched = false;
      return 'continue';
    }
  }

  // All active players have acted and matched — advance street
  return advanceStreet(state);
}

function advanceStreet(state) {
  const hand = state.hand;

  // Reset bets for new street
  for (const p of Object.values(hand.players)) {
    p.bet = 0;
    p.acted = false;
  }
  hand.currentBet = 0;

  const streets = ['preflop', 'flop', 'turn', 'river'];
  const currentStreetIdx = streets.indexOf(hand.street);

  if (currentStreetIdx >= 3) {
    // After river — showdown
    const activePlayers = hand.seats.filter(s => !hand.players[s.botName].folded);
    resolveHand(state, activePlayers);
    return 'showdown';
  }

  // Deal community cards
  const nextStreet = streets[currentStreetIdx + 1];
  hand.street = nextStreet;

  if (nextStreet === 'flop') {
    hand.deck.pop(); // burn
    hand.community.push(hand.deck.pop(), hand.deck.pop(), hand.deck.pop());
  } else {
    hand.deck.pop(); // burn
    hand.community.push(hand.deck.pop());
  }

  // Log the deal
  logAction(state, {
    bot: 'dealer',
    displayName: 'Dealer',
    action: 'deal',
    message: `deals the ${nextStreet}: ${formatCards(hand.community)}`,
    visibility: 'public',
  });

  // Check if all remaining players are all-in — skip to showdown
  const activePlayers = hand.seats.filter(s => !hand.players[s.botName].folded);
  const allAllIn = activePlayers.every(s => hand.players[s.botName].chips === 0);
  if (allAllIn) {
    // Deal remaining streets and resolve
    while (hand.community.length < 5) {
      const nextS = hand.community.length === 3 ? 'turn' : 'river';
      hand.deck.pop(); // burn
      hand.community.push(hand.deck.pop());
      logAction(state, {
        bot: 'dealer',
        displayName: 'Dealer',
        action: 'deal',
        message: `deals the ${nextS}: ${formatCards(hand.community)}`,
        visibility: 'public',
      });
    }
    hand.street = 'river';
    resolveHand(state, activePlayers);
    return 'showdown';
  }

  // First to act post-flop: first non-folded player after dealer
  const seats = hand.seats;
  for (let i = 1; i <= seats.length; i++) {
    const idx = (hand.dealerIndex + i) % seats.length;
    if (!hand.players[seats[idx].botName].folded) {
      hand.activePlayer = seats[idx].botName;
      hand.activePlayerDispatched = false;
      break;
    }
  }

  return 'continue';
}

export function resolveHand(state, activePlayers) {
  const hand = state.hand;

  // Deal remaining community cards if needed
  while (hand.community.length < 5) {
    hand.deck.pop(); // burn
    hand.community.push(hand.deck.pop());
  }

  if (activePlayers.length === 1) {
    // Last player standing — wins without showdown
    const winner = activePlayers[0].botName;
    const winnerPlayer = hand.players[winner];
    winnerPlayer.chips += hand.pot;
    state.buyIns[winner] = winnerPlayer.chips;

    hand.result = {
      winners: [winner],
      handName: 'Last player standing',
      evaluations: hand.seats.map(s => ({
        botName: s.botName,
        hand: hand.players[s.botName].folded ? 'Folded' : 'Winner',
        bestCards: [],
      })),
    };
  } else {
    // Showdown — evaluate hands
    const contenders = activePlayers.map(s => ({
      botName: s.botName,
      cards: hand.players[s.botName].cards,
    }));

    const result = determineWinners(contenders, hand.community);
    hand.result = result;

    // Distribute pot
    const share = Math.floor(hand.pot / result.winners.length);
    const remainder = hand.pot - share * result.winners.length;
    for (const winner of result.winners) {
      hand.players[winner].chips += share;
      state.buyIns[winner] = hand.players[winner].chips;
    }
    // Give remainder to first winner
    if (remainder > 0) {
      hand.players[result.winners[0]].chips += remainder;
      state.buyIns[result.winners[0]] = hand.players[result.winners[0]].chips;
    }
  }

  hand.activePlayer = null;
}
