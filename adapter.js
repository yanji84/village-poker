/**
 * Poker adapter — Texas Hold'em for Village Hub.
 *
 * Thin wiring layer: connects hub phases/tools to the game engine.
 * Game logic lives in game.js, scene building in scene.js, hand evaluation in logic.js.
 */

import { waitingScene, bettingScene, showdownScene, finishedScene } from './scene.js';
import {
  BUY_IN, dealNewHand, advanceAction, getActivePlayer, getBlinds, resolveHand,
} from './game.js';
import { logAction } from 'agent-village-hub/helpers';

// --- State ---

export function initState(worldConfig) {
  return {
    log: [],
    buyIns: {},       // botName → chip count (persists across hands)
    chipBank: {},     // username → saved chip count (persists across leave/rejoin)
    handsPlayed: 0,
    gamesPlayed: 0,
    leaderboard: {},  // botName → { wins, gamesPlayed, displayName }
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
      // Clear stale state from previous game
      if (state.hand) state.hand.result = null;
      state.winner = null;
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

      // --- Stuck hand recovery ---
      // If same player has been active for 5+ ticks, force auto-fold and move on
      if (!hand._stuckCheckTick) hand._stuckCheckTick = state.clock.tick;
      if (!hand._stuckCheckPlayer) hand._stuckCheckPlayer = hand.activePlayer;
      if (hand._stuckCheckPlayer !== hand.activePlayer) {
        hand._stuckCheckTick = state.clock.tick;
        hand._stuckCheckPlayer = hand.activePlayer;
      }
      if (state.clock.tick - hand._stuckCheckTick >= 5) {
        const stuckP = hand.players[hand.activePlayer];
        if (stuckP && !stuckP.folded) {
          // Auto-check if possible, otherwise fold
          if (stuckP.bet >= hand.currentBet) {
            stuckP.acted = true;
          } else {
            stuckP.folded = true;
          }
          hand._stuckCheckTick = state.clock.tick;
          advanceAction(state);
          return hand.activePlayer;
        }
      }

      // All-in players can't act — skip them immediately
      const activeP = hand.players[hand.activePlayer];
      if (activeP && !activeP.folded && activeP.chips === 0) {
        activeP.acted = true;
        advanceAction(state);
        return hand.activePlayer;
      }

      // If only one player has chips and all others are folded or all-in,
      // auto-check and advance — no decision needed from the LLM
      if (activeP && !activeP.folded && activeP.chips > 0) {
        const nonFolded = Object.entries(hand.players).filter(([, p]) => !p.folded);
        const withChips = nonFolded.filter(([, p]) => p.chips > 0);
        if (withChips.length <= 1 && nonFolded.length >= 2) {
          activeP.acted = true;
          advanceAction(state);
          return hand.activePlayer;
        }
      }

      // First dispatch: mark as dispatched, give them a chance to act
      if (!hand.activePlayerDispatched) {
        hand.activePlayerDispatched = 1;
        return hand.activePlayer;
      }

      // Give 2 dispatches before auto-folding (LLM responses can span multiple ticks)
      if (hand.activePlayerDispatched < 2) {
        hand.activePlayerDispatched++;
        return hand.activePlayer;
      }

      // Dispatched twice but didn't act — auto-fold (respects forced-call rules)
      const p = hand.players[hand.activePlayer];
      if (p && !p.folded) {
        const seat = hand.seats.find(s => s.botName === hand.activePlayer);

        // Check if this player has a hand worth forcing a call (bots only — humans can fold freely)
        const isHumanTimeout = state.hubBots?.[hand.activePlayer]?.playMode === 'human';
        let forceCall = false;
        if (p.cards && !isHumanTimeout) {
          if (hand.street === 'preflop') {
            const toCallAmount = hand.currentBet - p.bet;
            const reasonableBet = toCallAmount <= hand.bigBlind * 4;
            const c1 = p.cards[0] || '';
            const c2 = p.cards[1] || '';
            const r1 = c1.replace(/[♠♥♦♣]/g, '');
            const r2 = c2.replace(/[♠♥♦♣]/g, '');
            const s1 = c1.replace(/[^♠♥♦♣]/g, '');
            const s2 = c2.replace(/[^♠♥♦♣]/g, '');
            const rankOrder = '23456789TJQKA';
            const r1i = rankOrder.indexOf(r1);
            const r2i = rankOrder.indexOf(r2);
            const isPair = r1 === r2;
            const hasAce = r1 === 'A' || r2 === 'A';
            const hasFace = r1i >= 9 && r2i >= 9;
            const isSuitedBroadway = s1 === s2 && r1i >= 7 && r2i >= 7;
            if (reasonableBet) {
              const isSuited = s1 === s2;
              const gap = Math.abs(r1i - r2i);
              forceCall = isPair || hasAce || (isSuited && (r1i >= 5 || r2i >= 5)) || (gap <= 1 && r1i >= 5 && r2i >= 5);
            } else {
              forceCall = isPair || hasAce || hasFace || isSuitedBroadway;
            }
          } else if (hand.community?.length >= 3) {
            const allCards = [...(p.cards || []), ...(hand.community || [])];
            const ranks = allCards.map(c => c.replace(/[♠♥♦♣]/g, ''));
            const rankCounts = {};
            for (const r of ranks) rankCounts[r] = (rankCounts[r] || 0) + 1;
            forceCall = Object.values(rankCounts).some(c => c >= 2);
          }
        }

        if (forceCall) {
          // Force check or call instead of folding
          const toCall = Math.min(hand.currentBet - p.bet, p.chips);
          if (toCall > 0) {
            p.chips -= toCall;
            p.bet += toCall;
            p.totalBet += toCall;
            hand.pot += toCall;
            state.buyIns[hand.activePlayer] = p.chips;
          }
          p.acted = true;
          logAction(state, {
            bot: hand.activePlayer,
            displayName: seat?.displayName || hand.activePlayer,
            action: toCall > 0 ? 'call' : 'check',
            message: toCall > 0 ? `calls ${toCall} (auto, timed out)` : 'checks (auto, timed out)',
            visibility: 'public',
          });
          advanceAction(state);
        } else {
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
      }

      return hand.activePlayer;
    },
    transitions: [
      { to: 'showdown', when: (state) => state.hand?.result != null },
      {
        // Emergency timeout: if a hand has been in betting for 20+ ticks (~10min at 30s),
        // force-fold everyone except the player with most chips invested and resolve
        to: 'showdown',
        when: (state) => {
          if (!state.hand || !state.hand._bettingStartTick) {
            if (state.hand) state.hand._bettingStartTick = state.clock.tick;
            return false;
          }
          if (state.clock.tick - state.hand._bettingStartTick < 20) return false;
          // Force resolve: fold all but the player with highest bet
          const players = state.hand.players;
          let maxBet = -1, maxBot = null;
          for (const [bot, p] of Object.entries(players)) {
            if (!p.folded && p.bet > maxBet) { maxBet = p.bet; maxBot = bot; }
          }
          for (const [bot, p] of Object.entries(players)) {
            if (bot !== maxBot && !p.folded) p.folded = true;
          }
          const activePlayers = Object.entries(players).filter(([, p]) => !p.folded);
          resolveHand(state, activePlayers);
          return true;
        },
      },
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
          // Wait 2 ticks (~60s) so observers can see the showdown result
          if (!state._showdownEnteredTick) state._showdownEnteredTick = state.clock.tick;
          if (state.clock.tick - state._showdownEnteredTick < 2) return false;
          state._showdownEnteredTick = null;
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
        // Auto-restart: wait 1 tick for observers to see the result, then reset
        to: 'waiting',
        when: (state) => {
          if (!state.restartAfterTick) {
            // Recovery from old state or missed onEnter — set it now
            state.restartAfterTick = state.clock.tick;
            return false;
          }
          if (state.clock.tick <= state.restartAfterTick) return false;
          // Reset all buy-ins for a fresh game
          for (const bot of state.bots) {
            state.buyIns[bot] = BUY_IN;
          }
          state.handsPlayed = 0;
          // Don't wipe chipBank — players who left still need their saved chips on rejoin
          return true;
        },
      },
    ],
    onEnter(state) {
      state.gamesPlayed = (state.gamesPlayed || 0) + 1;
      if (!state.leaderboard) state.leaderboard = {};

      const winner = state.bots.find(b => (state.buyIns[b] || 0) > 0);
      if (winner) {
        const displayName = state.remoteParticipants?.[winner]?.displayName || winner;
        state.winner = { botName: winner, displayName, chips: state.buyIns[winner], handsPlayed: state.handsPlayed };

        // Update leaderboard for all participants (skip ephemeral players)
        for (const bot of state.bots) {
          if (state.hubBots?.[bot]?.ephemeral) continue;
          if (!state.leaderboard[bot]) {
            state.leaderboard[bot] = { wins: 0, gamesPlayed: 0, displayName: state.remoteParticipants?.[bot]?.displayName || bot };
          }
          state.leaderboard[bot].gamesPlayed++;
          state.leaderboard[bot].displayName = state.hubBots?.[bot]?.displayName || state.remoteParticipants?.[bot]?.displayName || bot;
          state.leaderboard[bot].username = state.hubBots?.[bot]?.claimedBy || null;
        }
        if (!state.hubBots?.[winner]?.ephemeral) {
          state.leaderboard[winner].wins++;
        }

        logAction(state, {
          bot: 'dealer',
          displayName: 'Dealer',
          action: 'game_over',
          message: `${displayName} wins the game with ${state.buyIns[winner]} chips after ${state.handsPlayed} hands!`,
          visibility: 'public',
        });
      }

      // Auto-restart after 1 tick
      state.restartAfterTick = state.clock.tick;
    },
  },
};

// --- Helpers ---

function emitSay(bot, params, state) {
  if (!params?.say) return;
  const seat = state.hand?.seats?.find(s => s.botName === bot.name);
  logAction(state, {
    bot: bot.name,
    displayName: seat?.displayName || bot.displayName || bot.name,
    action: 'say',
    message: params.say,
    visibility: 'public',
  });
}

// --- Tool handlers ---

export const tools = {
  poker_check(bot, params, state) {
    const active = getActivePlayer(state, bot);
    if (!active) {
      console.error(`[poker] CHECK rejected for ${bot.name}: not active player or already acted`);
      return null;
    }
    const { hand, player } = active;
    // If facing a bet, treat check as a call (LLMs often pick check when they mean call)
    if (player.bet < hand.currentBet) {
      const toCall = Math.min(hand.currentBet - player.bet, player.chips);
      if (toCall <= 0) return null;
      player.chips -= toCall;
      player.bet += toCall;
      player.totalBet += toCall;
      hand.pot += toCall;
      state.buyIns[bot.name] = player.chips;
      player.acted = true;
    player.lastActedTick = state.clock.tick;
      emitSay(bot, params, state);
      advanceAction(state);
      return {
        action: 'call',
        amount: toCall,
        message: `calls ${toCall}`,
        visibility: 'public',
        ...(params?.thought ? { thought: params.thought } : {}),
      };
    }

    player.acted = true;
    player.lastActedTick = state.clock.tick;
    emitSay(bot, params, state);
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
    player.lastActedTick = state.clock.tick;
    emitSay(bot, params, state);

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
    player.lastActedTick = state.clock.tick;
    emitSay(bot, params, state);

    // Reset acted for everyone else (they need to respond to the raise)
    for (const [name, other] of Object.entries(hand.players)) {
      if (name !== bot.name && !other.folded) {
        other.acted = false;
      }
    }

    advanceAction(state);

    const isAllIn = player.chips === 0;
    // "bet" when no prior bet this street (only blinds), "raise" when increasing an existing bet
    const isBet = hand.currentBet <= hand.bigBlind && cost === amount;
    const actionWord = isBet ? 'bet' : 'raise';
    const label = isAllIn
      ? `goes all-in for ${amount}`
      : isBet ? `bets ${amount}` : `raises to ${amount}`;

    return {
      action: isAllIn ? 'allin' : actionWord,
      amount,
      message: label,
      visibility: 'public',
      ...(params?.thought ? { thought: params.thought } : {}),
    };
  },

  poker_fold(bot, params, state) {
    const active = getActivePlayer(state, bot);
    if (!active) return null;
    const { hand, player } = active;

    // Can't fold when there's nothing to call — convert to check
    if (player.bet >= hand.currentBet) {
      player.acted = true;
    player.lastActedTick = state.clock.tick;
      emitSay(bot, params, state);
      advanceAction(state);
      return {
        action: 'check',
        message: 'checks',
        visibility: 'public',
        ...(params?.thought ? { thought: params.thought } : {}),
      };
    }

    // Force call with playable hands to ensure action and showdowns (bots only — humans can always fold)
    const isHuman = state.hubBots?.[bot.name]?.playMode === 'human';
    if (player.cards && !isHuman) {
      let forceCall = false;

      if (hand.street === 'preflop') {
        // Preflop: force call only with genuinely playable hands
        // AND only when the bet is reasonable (≤ 4x BB)
        const toCallAmount = hand.currentBet - player.bet;
        const reasonableBet = toCallAmount <= hand.bigBlind * 4;
        const c1 = player.cards[0] || '';
        const c2 = player.cards[1] || '';
        const r1 = c1.replace(/[♠♥♦♣]/g, '');
        const r2 = c2.replace(/[♠♥♦♣]/g, '');
        const s1 = c1.replace(/[^♠♥♦♣]/g, '');
        const s2 = c2.replace(/[^♠♥♦♣]/g, '');
        const isPair = r1 === r2;
        const hasAce = r1 === 'A' || r2 === 'A';
        const rankOrder = '23456789TJQKA';
        const r1i = rankOrder.indexOf(r1);
        const r2i = rankOrder.indexOf(r2);
        const hasFace = r1i >= 9 && r2i >= 9; // both T or higher
        const isSuitedBroadway = s1 === s2 && r1i >= 7 && r2i >= 7; // suited 9+
        // Only force call with premium-ish hands, or any playable hand at reasonable bet size
        if (reasonableBet) {
          const isSuited = s1 === s2;
          const gap = Math.abs(r1i - r2i);
          const isConnected = gap <= 1;
          forceCall = isPair || hasAce || (isSuited && (r1i >= 5 || r2i >= 5)) || (isConnected && r1i >= 5 && r2i >= 5);
        } else {
          // Large bet: only force with strong hands
          forceCall = isPair || hasAce || hasFace || isSuitedBroadway;
        }
      } else if (hand.community?.length >= 3) {
        // Post-flop: force call with any pair or better
        const allCards = [...(player.cards || []), ...(hand.community || [])];
        const ranks = allCards.map(c => c.replace(/[♠♥♦♣]/g, ''));
        const rankCounts = {};
        for (const r of ranks) rankCounts[r] = (rankCounts[r] || 0) + 1;
        forceCall = Object.values(rankCounts).some(c => c >= 2);
      }

      if (forceCall) {
        // Convert to call or check
        const toCall = Math.min(hand.currentBet - player.bet, player.chips);
        if (toCall > 0) {
          player.chips -= toCall;
          player.bet += toCall;
          player.totalBet += toCall;
          hand.pot += toCall;
          state.buyIns[bot.name] = player.chips;
          player.acted = true;
    player.lastActedTick = state.clock.tick;
          emitSay(bot, params, state);
          advanceAction(state);
          return {
            action: 'call',
            amount: toCall,
            message: `calls ${toCall} (forced showdown)`,
            visibility: 'public',
            ...(params?.thought ? { thought: params.thought } : {}),
          };
        } else {
          player.acted = true;
    player.lastActedTick = state.clock.tick;
          emitSay(bot, params, state);
          advanceAction(state);
          return {
            action: 'check',
            message: 'checks (forced showdown)',
            visibility: 'public',
            ...(params?.thought ? { thought: params.thought } : {}),
          };
        }
      }
    }

    player.folded = true;
    player.acted = true;
    player.lastActedTick = state.clock.tick;
    emitSay(bot, params, state);

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
  const username = displayName.toLowerCase();
  if (state.chipBank?.[username] != null && state.chipBank[username] > 0) {
    state.buyIns[botName] = state.chipBank[username];
    delete state.chipBank[username];
  } else if (!state.buyIns[botName]) {
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

  // Save chips for rejoin
  const username = displayName.toLowerCase();
  if (chips > 0) {
    if (!state.chipBank) state.chipBank = {};
    state.chipBank[username] = chips;
  }

  delete state.buyIns[botName];

  return { message: `${displayName} leaves the table${chips > 0 ? ` with ${chips} chips (saved for return)` : ''}.` };
}
