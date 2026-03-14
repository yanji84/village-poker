/**
 * Poker adapter — Texas Hold'em for Village Hub.
 *
 * Phases: waiting → betting → showdown → (loop)
 * Turn: round-robin during betting, none during waiting/showdown
 * Visibility: hole cards are private, bets/folds/community cards are public
 */

import { createDeck, shuffle, determineWinners, formatCards } from './logic.js';
import { waitingScene, bettingScene, showdownScene } from './scene.js';

// --- Config ---

const BUY_IN = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

// --- State ---

export function initState(worldConfig) {
  return {
    log: [],
    buyIns: {},       // botName → chip count (persists across hands)
    handsPlayed: 0,
  };
}

// --- Hand management ---

function dealNewHand(state) {
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
    state.log.push({
      bot: seat.botName,
      displayName: seat.displayName,
      action: 'deal_hole',
      cards: players[seat.botName].cards.slice(),
      message: `is dealt ${formatCards(players[seat.botName].cards)}`,
      visibility: 'private',
      tick: state.clock.tick,
      timestamp: new Date().toISOString(),
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
  state.log.push({
    bot: botName,
    displayName: seat?.displayName || botName,
    action: 'blind',
    blindType: type,
    amount: actual,
    message: `posts ${type} blind (${actual})`,
    visibility: 'public',
    tick: state.clock.tick,
    timestamp: new Date().toISOString(),
  });
}

function advanceAction(state) {
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
  state.log.push({
    bot: 'dealer',
    displayName: 'Dealer',
    action: 'deal',
    message: `deals the ${nextStreet}: ${formatCards(hand.community)}`,
    visibility: 'public',
    tick: state.clock.tick,
    timestamp: new Date().toISOString(),
  });

  // Check if all remaining players are all-in — skip to showdown
  const activePlayers = hand.seats.filter(s => !hand.players[s.botName].folded);
  const allAllIn = activePlayers.every(s => hand.players[s.botName].chips === 0);
  if (allAllIn) {
    // Deal remaining streets and resolve
    while (hand.community.length < 5) {
      const streetsLeft = ['flop', 'turn', 'river'];
      const nextS = hand.community.length === 0 ? 'flop' : (hand.community.length === 3 ? 'turn' : 'river');
      hand.deck.pop(); // burn
      if (hand.community.length === 0) {
        hand.community.push(hand.deck.pop(), hand.deck.pop(), hand.deck.pop());
      } else {
        hand.community.push(hand.deck.pop());
      }
      state.log.push({
        bot: 'dealer',
        displayName: 'Dealer',
        action: 'deal',
        message: `deals the ${nextS}: ${formatCards(hand.community)}`,
        visibility: 'public',
        tick: state.clock.tick,
        timestamp: new Date().toISOString(),
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
      break;
    }
  }

  return 'continue';
}

function resolveHand(state, activePlayers) {
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

// --- Phases ---

export const phases = {
  waiting: {
    turn: 'none',
    tools: ['poker_say', 'poker_think'],
    scene: waitingScene,
    transitions: [
      {
        to: 'betting',
        when: (state) => {
          // Auto rebuy busted players
          for (const bot of state.bots) {
            if ((state.buyIns[bot] || 0) <= 0) {
              state.buyIns[bot] = BUY_IN;
            }
          }
          const playersWithChips = state.bots.filter(b => (state.buyIns[b] || 0) > 0);
          return playersWithChips.length >= 2;
        },
      },
    ],
    onEnter(state) {
      // Clear stale hand result
      if (state.hand) state.hand.result = null;
      // Try to deal a new hand
      if (!dealNewHand(state)) {
        // Not enough players with chips — will stay in waiting
      }
    },
  },

  betting: {
    turn: 'parallel',
    tools: ['poker_check', 'poker_call', 'poker_raise', 'poker_fold', 'poker_think', 'poker_say'],
    scene: bettingScene,
    transitions: [
      // Transition to showdown is triggered by advanceAction returning 'showdown'
      { to: 'showdown', when: (state) => state.hand?.result != null },
    ],
  },

  showdown: {
    turn: 'none',
    tools: ['poker_say', 'poker_think'],
    scene: showdownScene,
    transitions: [
      // After one tick of showdown, start next hand
      {
        to: 'betting',
        when: (state) => {
          const playersWithChips = state.bots.filter(b => (state.buyIns[b] || 0) > 0);
          return playersWithChips.length >= 2;
        },
      },
      {
        to: 'waiting',
        when: () => true, // fallback — not enough players
      },
    ],
    onEnter(state) {
      // Log the result
      const hand = state.hand;
      if (hand?.result) {
        const winnerNames = hand.result.winners.map(w => hand.seats.find(s => s.botName === w)?.displayName || w);
        const share = Math.floor(hand.pot / hand.result.winners.length);
        state.log.push({
          bot: 'dealer',
          displayName: 'Dealer',
          action: 'result',
          message: `${winnerNames.join(', ')} wins ${share} chips with ${hand.result.handName}!`,
          visibility: 'public',
          tick: state.clock.tick,
          timestamp: new Date().toISOString(),
        });
      }
    },
  },
};

// onEnter for betting: deal a new hand when transitioning from showdown
const _originalBettingOnEnter = phases.betting.onEnter;
phases.betting.onEnter = (state) => {
  _originalBettingOnEnter?.(state);
  dealNewHand(state);
};

// --- Tool handlers ---

export const tools = {
  poker_check(bot, params, state) {
    const hand = state.hand;
    if (!hand || hand.activePlayer !== bot.name) return null;

    const p = hand.players[bot.name];
    if (!p || p.folded) return null;
    if (p.bet < hand.currentBet) return null; // can't check when facing a bet

    p.acted = true;
    const result = advanceAction(state);

    return {
      action: 'check',
      message: 'checks',
      visibility: 'public',
    };
  },

  poker_call(bot, params, state) {
    const hand = state.hand;
    if (!hand || hand.activePlayer !== bot.name) return null;

    const p = hand.players[bot.name];
    if (!p || p.folded) return null;

    const toCall = Math.min(hand.currentBet - p.bet, p.chips);
    if (toCall <= 0) return null; // nothing to call

    p.chips -= toCall;
    p.bet += toCall;
    p.totalBet += toCall;
    hand.pot += toCall;
    state.buyIns[bot.name] = p.chips;
    p.acted = true;

    advanceAction(state);

    return {
      action: 'call',
      amount: toCall,
      message: `calls ${toCall}`,
      visibility: 'public',
    };
  },

  poker_raise(bot, params, state) {
    const hand = state.hand;
    if (!hand || hand.activePlayer !== bot.name) return null;

    const p = hand.players[bot.name];
    if (!p || p.folded) return null;

    let amount = params?.amount;
    if (typeof amount !== 'number' || amount <= 0) return null;

    const minRaise = Math.max(hand.currentBet * 2, hand.bigBlind);

    // All-in if raise exceeds chips
    const totalNeeded = amount - p.bet;
    if (totalNeeded >= p.chips) {
      // All-in
      amount = p.bet + p.chips;
    } else if (amount < minRaise) {
      // Below minimum — treat as min raise
      amount = Math.min(minRaise, p.bet + p.chips);
    }

    const cost = amount - p.bet;
    p.chips -= cost;
    p.bet = amount;
    p.totalBet += cost;
    hand.pot += cost;
    hand.currentBet = amount;
    state.buyIns[bot.name] = p.chips;
    p.acted = true;

    // Reset acted for everyone else (they need to respond to the raise)
    for (const [name, player] of Object.entries(hand.players)) {
      if (name !== bot.name && !player.folded) {
        player.acted = false;
      }
    }

    advanceAction(state);

    return {
      action: 'raise',
      amount,
      message: `raises to ${amount}${p.chips === 0 ? ' (all-in!)' : ''}`,
      visibility: 'public',
    };
  },

  poker_fold(bot, params, state) {
    const hand = state.hand;
    if (!hand || hand.activePlayer !== bot.name) return null;

    const p = hand.players[bot.name];
    if (!p || p.folded) return null;

    p.folded = true;
    p.acted = true;

    advanceAction(state);

    return {
      action: 'fold',
      message: 'folds',
      visibility: 'public',
    };
  },

  poker_think(bot, params, state) {
    if (!params?.thought) return null;
    return {
      action: 'think',
      message: params.thought,
      visibility: 'private',
    };
  },

  poker_say(bot, params, state) {
    if (!params?.message) return null;
    return {
      action: 'say',
      message: params.message,
      visibility: 'public',
    };
  },
};

// --- Join/Leave hooks ---

export function onJoin(state, botName, displayName) {
  // Give buy-in chips
  if (!state.buyIns[botName]) {
    state.buyIns[botName] = BUY_IN;
  }

  const message = `${displayName} sits down at the table (${state.buyIns[botName]} chips).`;
  state.log.push({
    bot: botName, displayName, action: 'join', message,
    visibility: 'public',
    tick: state.clock.tick, timestamp: new Date().toISOString(),
  });
  return { message };
}

export function onLeave(state, botName, displayName) {
  const chips = state.buyIns[botName] || 0;
  const message = `${displayName} leaves the table${chips > 0 ? ` with ${chips} chips` : ''}.`;

  // If in a hand, fold them
  if (state.hand?.players?.[botName] && !state.hand.players[botName].folded) {
    state.hand.players[botName].folded = true;
    if (state.hand.activePlayer === botName) {
      advanceAction(state);
    }
  }

  delete state.buyIns[botName];

  state.log.push({
    bot: botName, displayName, action: 'leave', message,
    visibility: 'public',
    tick: state.clock.tick, timestamp: new Date().toISOString(),
  });
  return { message };
}
