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
export const BASE_SMALL_BLIND = 10;
export const BASE_BIG_BLIND = 20;

// Blinds escalate every BLIND_ESCALATION_INTERVAL hands (doubling each level)
export const BLIND_ESCALATION_INTERVAL = 20;

/**
 * Get current blind amounts based on hands played.
 * Blinds double every 20 hands: 10/20 → 20/40 → 40/80 → ...
 * Capped at level 5 (320/640) to prevent exceeding buy-in.
 */
export function getBlinds(handsPlayed) {
  const level = Math.min(Math.floor(handsPlayed / BLIND_ESCALATION_INTERVAL), 2); // cap at 40/80 so 1000 buy-in stays playable
  const multiplier = Math.pow(2, level);
  return {
    small: BASE_SMALL_BLIND * multiplier,
    big: BASE_BIG_BLIND * multiplier,
    level,
  };
}

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
  // All-in players (0 chips) cannot take any action
  if (player.chips === 0) return null;
  // Prevent double-action: if already acted and bet matches current, reject
  if (player.acted && player.bet >= hand.currentBet) {
    console.error(`[village] BLOCKED double-action: ${bot.name} acted=${player.acted} bet=${player.bet} currentBet=${hand.currentBet}`);
    return null;
  }
  // Prevent same-tick double-action: if player already acted this tick, reject
  if (player.lastActedTick === state.clock.tick) {
    console.error(`[village] BLOCKED same-tick double-action: ${bot.name} already acted at tick ${state.clock.tick}`);
    return null;
  }
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
    bigBlind: null,    // set below after blind calculation
    smallBlind: null,  // set below after blind calculation
    blindLevel: null,  // set below after blind calculation
    street: 'preflop',
    activePlayer: null,
    actedCount: 0,
    result: null,
    startTick: state.clock.tick,
  };

  // Snapshot pre-hand chip counts for accurate archival (before blinds/bets/pot distribution)
  state.hand.chipsBeforeHand = {};
  for (const bot of bots) {
    state.hand.chipsBeforeHand[bot] = state.buyIns[bot] || 0;
  }

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

  const blinds = getBlinds(state.handsPlayed);
  state.hand.smallBlind = blinds.small;
  state.hand.bigBlind = blinds.big;
  state.hand.blindLevel = blinds.level;

  postBlind(state, seats[sbIndex].botName, blinds.small, 'small');
  postBlind(state, seats[bbIndex].botName, blinds.big, 'big');

  state.hand.currentBet = blinds.big;

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
  const isAllIn = p.chips === 0;
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
    message: isAllIn ? `posts ${type} blind (${actual}) — all-in` : `posts ${type} blind (${actual})`,
    visibility: 'public',
  });

  // Mark as acted if all-in — they can't do anything more
  if (p.chips === 0) {
    p.acted = true;
  }
}

export function advanceAction(state) {
  const hand = state.hand;
  const seats = hand.seats;

  // Mark the current active player's tick to prevent double-action
  // (when a bot's response has 2 actions and the first advances the street
  // back to the same player as first-to-act on the new street)
  if (hand.activePlayer && hand.players[hand.activePlayer]) {
    hand.players[hand.activePlayer].lastActedTick = state.clock.tick;
  }

  const activePlayers = seats.filter(s => hand.players[s.botName] && !hand.players[s.botName].folded);

  // One player left — they win
  if (activePlayers.length === 1) {
    resolveHand(state, activePlayers);
    return 'showdown';
  }

  // Find next non-folded, non-all-in player who hasn't acted (or needs to match a raise)
  const currentIndex = seats.findIndex(s => s.botName === hand.activePlayer);
  for (let i = 1; i <= seats.length; i++) {
    const idx = (currentIndex + i) % seats.length;
    const seat = seats[idx];
    const p = hand.players[seat.botName];
    if (p.folded) continue;
    // Skip all-in players — they can't act
    if (p.chips === 0) continue;
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
  hand._streetChecks = {};
  hand.currentBet = 0;

  const streets = ['preflop', 'flop', 'turn', 'river'];
  const currentStreetIdx = streets.indexOf(hand.street);

  if (currentStreetIdx >= 3) {
    // After river — showdown
    const activePlayers = hand.seats.filter(s => hand.players[s.botName] && !hand.players[s.botName].folded);
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

  // Check if all remaining players are all-in (or at most one has chips) — skip to showdown
  const activePlayers = hand.seats.filter(s => hand.players[s.botName] && !hand.players[s.botName].folded);
  const playersWithChips = activePlayers.filter(s => hand.players[s.botName]?.chips > 0);
  if (playersWithChips.length <= 1) {
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

  // First to act post-flop: first non-folded, non-all-in player after dealer
  const seats = hand.seats;
  for (let i = 1; i <= seats.length; i++) {
    const idx = (hand.dealerIndex + i) % seats.length;
    const p = hand.players[seats[idx].botName];
    if (!p.folded && p.chips > 0) {
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
    // Showdown — evaluate hands with side pot support
    const contenders = activePlayers
      .filter(s => hand.players[s.botName]?.cards?.length >= 2)
      .map(s => ({
        botName: s.botName,
        cards: hand.players[s.botName].cards,
      }));
    if (contenders.length === 0) {
      hand.result = { winners: [], handName: 'No contest', evaluations: [] };
      hand.activePlayer = null;
      return;
    }

    const result = determineWinners(contenders, hand.community);
    hand.result = result;

    // Build side pots: each all-in amount creates a pot that only players
    // who matched that amount can win
    const allBets = Object.entries(hand.players).map(([name, p]) => ({ name, totalBet: p.totalBet || 0 }));
    const uniqueBets = [...new Set(allBets.map(b => b.totalBet))].sort((a, b) => a - b);

    let distributed = 0;
    let prevLevel = 0;
    for (const level of uniqueBets) {
      if (level === 0) continue;
      const increment = level - prevLevel;
      // Each player contributes min(their totalBet, level) - prevLevel to this pot
      let potPortion = 0;
      const eligible = [];
      for (const { name, totalBet } of allBets) {
        const contribution = Math.min(totalBet, level) - Math.min(totalBet, prevLevel);
        potPortion += contribution;
        // Only non-folded players who bet at least this level can win
        if (!hand.players[name].folded && totalBet >= level) {
          eligible.push(name);
        }
      }
      if (potPortion > 0 && eligible.length > 0) {
        // Find best hand among eligible
        const eligibleContenders = eligible.filter(n => contenders.some(c => c.botName === n));
        let potWinners;
        if (eligibleContenders.length === 1) {
          potWinners = eligibleContenders;
        } else if (eligibleContenders.length > 1) {
          const subResult = determineWinners(
            contenders.filter(c => eligibleContenders.includes(c.botName)),
            hand.community
          );
          potWinners = subResult.winners;
        } else {
          // No eligible contenders (all folded) — give to overall winner
          potWinners = result.winners;
        }
        const share = Math.floor(potPortion / potWinners.length);
        const rem = potPortion - share * potWinners.length;
        for (const w of potWinners) {
          hand.players[w].chips += share;
          state.buyIns[w] = hand.players[w].chips;
        }
        if (rem > 0) {
          hand.players[potWinners[0]].chips += rem;
          state.buyIns[potWinners[0]] = hand.players[potWinners[0]].chips;
        }
        distributed += potPortion;
      }
      prevLevel = level;
    }

    // Safety: if any pot wasn't distributed (shouldn't happen), give to winner
    const undistributed = hand.pot - distributed;
    if (undistributed > 0) {
      hand.players[result.winners[0]].chips += undistributed;
      state.buyIns[result.winners[0]] = hand.players[result.winners[0]].chips;
    }
  }

  hand.activePlayer = null;

  // Reveal all non-folded players' hole cards for showdown
  const revealedCards = {};
  const handNames = {};
  for (const [botName, p] of Object.entries(hand.players)) {
    if (!p.folded && p.cards) {
      revealedCards[botName] = p.cards;
    }
  }
  // Include per-player hand evaluations
  if (hand.result?.evaluations) {
    for (const ev of hand.result.evaluations) {
      handNames[ev.botName] = ev.hand;
    }
  }
  if (Object.keys(revealedCards).length > 1) {
    logAction(state, {
      bot: 'dealer',
      displayName: 'Dealer',
      action: 'showdown_reveal',
      cards: revealedCards,
      handNames,
      message: 'reveals cards at showdown',
      visibility: 'public',
    });
  }
}
