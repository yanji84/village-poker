/**
 * Poker adapter — Texas Hold'em for Village Hub.
 *
 * Thin wiring layer: connects hub phases/tools to the game engine.
 * Game logic lives in game.js, scene building in scene.js, hand evaluation in logic.js.
 */

import { waitingScene, bettingScene, showdownScene, finishedScene } from './scene.js';
import {
  BUY_IN, dealNewHand, advanceAction, getActivePlayer,
} from './game.js';
import { logAction } from 'openclaw-village-hub/helpers';

// --- State ---

export function initState(worldConfig) {
  return {
    log: [],
    buyIns: {},       // botName → chip count (persists across hands)
    handsPlayed: 0,
  };
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
          // Give initial buy-in to players without chips (new arrivals)
          for (const bot of state.bots) {
            if (state.buyIns[bot] == null) {
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
      dealNewHand(state);
    },
  },

  betting: {
    turn: 'active',
    tools: ['poker_check', 'poker_call', 'poker_raise', 'poker_fold'],
    scene: bettingScene,
    onEnter(state) {
      dealNewHand(state);
    },
    getActiveBot(state) {
      const hand = state.hand;
      if (!hand?.activePlayer) return null;

      // First dispatch: mark as dispatched, give them a chance to act
      if (!hand.activePlayerDispatched) {
        hand.activePlayerDispatched = true;
        return hand.activePlayer;
      }

      // Already dispatched but didn't act — auto-fold
      const p = hand.players[hand.activePlayer];
      if (p && !p.folded) {
        const seat = hand.seats.find(s => s.botName === hand.activePlayer);
        p.folded = true;
        p.acted = true;
        logAction(state, {
          bot: hand.activePlayer,
          displayName: seat?.displayName || hand.activePlayer,
          action: 'fold',
          message: 'is auto-folded (timed out)',
          visibility: 'public',
        });
        advanceAction(state);
      }

      return hand.activePlayer;
    },
    transitions: [
      { to: 'showdown', when: (state) => state.hand?.result != null },
    ],
  },

  showdown: {
    turn: 'none',
    tools: ['poker_say', 'poker_think'],
    scene: showdownScene,
    transitions: [
      {
        // Game over — one player has all the chips
        to: 'finished',
        when: (state) => {
          const playersWithChips = state.bots.filter(b => (state.buyIns[b] || 0) > 0);
          return playersWithChips.length === 1 && state.bots.length >= 2;
        },
      },
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
      const hand = state.hand;
      if (hand?.result) {
        const winnerNames = hand.result.winners.map(w => hand.seats.find(s => s.botName === w)?.displayName || w);
        const share = Math.floor(hand.pot / hand.result.winners.length);
        logAction(state, {
          bot: 'dealer',
          displayName: 'Dealer',
          action: 'result',
          message: `${winnerNames.join(', ')} wins ${share} chips with ${hand.result.handName}!`,
          visibility: 'public',
        });
      }
    },
  },

  finished: {
    turn: 'none',
    tools: ['poker_say', 'poker_think'],
    scene: finishedScene,
    transitions: [
      {
        // New game when a player leaves (resetting the table) or new players join
        to: 'waiting',
        when: (state) => {
          const playersWithChips = state.bots.filter(b => (state.buyIns[b] || 0) > 0);
          return playersWithChips.length !== 1 || state.bots.length < 2;
        },
      },
    ],
    onEnter(state) {
      const winner = state.bots.find(b => (state.buyIns[b] || 0) > 0);
      if (winner) {
        const displayName = state.remoteParticipants?.[winner]?.displayName || winner;
        state.winner = { botName: winner, displayName, chips: state.buyIns[winner], handsPlayed: state.handsPlayed };
        logAction(state, {
          bot: 'dealer',
          displayName: 'Dealer',
          action: 'game_over',
          message: `${displayName} wins the game with ${state.buyIns[winner]} chips after ${state.handsPlayed} hands!`,
          visibility: 'public',
        });
      }
    },
  },
};

// --- Tool handlers ---

export const tools = {
  poker_check(bot, params, state) {
    const active = getActivePlayer(state, bot);
    if (!active) return null;
    const { hand, player } = active;

    if (player.bet < hand.currentBet) return null; // can't check when facing a bet

    player.acted = true;
    advanceAction(state);

    return {
      action: 'check',
      message: 'checks',
      visibility: 'public',
      ...(params?.thought ? { thought: params.thought } : {}),
    };
  },

  poker_call(bot, params, state) {
    const active = getActivePlayer(state, bot);
    if (!active) return null;
    const { hand, player } = active;

    const toCall = Math.min(hand.currentBet - player.bet, player.chips);
    if (toCall <= 0) return null; // nothing to call

    player.chips -= toCall;
    player.bet += toCall;
    player.totalBet += toCall;
    hand.pot += toCall;
    state.buyIns[bot.name] = player.chips;
    player.acted = true;

    advanceAction(state);

    return {
      action: 'call',
      amount: toCall,
      message: `calls ${toCall}`,
      visibility: 'public',
      ...(params?.thought ? { thought: params.thought } : {}),
    };
  },

  poker_raise(bot, params, state) {
    const active = getActivePlayer(state, bot);
    if (!active) return null;
    const { hand, player } = active;

    let amount = params?.amount;
    if (typeof amount !== 'number' || amount <= 0) return null;

    const minRaise = Math.max(hand.currentBet * 2, hand.bigBlind);

    // All-in if raise exceeds chips
    const totalNeeded = amount - player.bet;
    if (totalNeeded >= player.chips) {
      amount = player.bet + player.chips;
    } else if (amount < minRaise) {
      amount = Math.min(minRaise, player.bet + player.chips);
    }

    const cost = amount - player.bet;
    player.chips -= cost;
    player.bet = amount;
    player.totalBet += cost;
    hand.pot += cost;
    hand.currentBet = amount;
    state.buyIns[bot.name] = player.chips;
    player.acted = true;

    // Reset acted for everyone else (they need to respond to the raise)
    for (const [name, other] of Object.entries(hand.players)) {
      if (name !== bot.name && !other.folded) {
        other.acted = false;
      }
    }

    advanceAction(state);

    return {
      action: 'raise',
      amount,
      message: `raises to ${amount}${player.chips === 0 ? ' (all-in!)' : ''}`,
      visibility: 'public',
      ...(params?.thought ? { thought: params.thought } : {}),
    };
  },

  poker_fold(bot, params, state) {
    const active = getActivePlayer(state, bot);
    if (!active) return null;
    const { player } = active;

    player.folded = true;
    player.acted = true;

    advanceAction(state);

    return {
      action: 'fold',
      message: 'folds',
      visibility: 'public',
      ...(params?.thought ? { thought: params.thought } : {}),
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
  if (!state.buyIns[botName]) {
    state.buyIns[botName] = BUY_IN;
  }
  return { message: `${displayName} sits down at the table (${state.buyIns[botName]} chips).` };
}

export function onLeave(state, botName, displayName) {
  const chips = state.buyIns[botName] || 0;

  // If in a hand, fold them
  if (state.hand?.players?.[botName] && !state.hand.players[botName].folded) {
    state.hand.players[botName].folded = true;
    if (state.hand.activePlayer === botName) {
      advanceAction(state);
    }
  }

  delete state.buyIns[botName];

  return { message: `${displayName} leaves the table${chips > 0 ? ` with ${chips} chips` : ''}.` };
}
