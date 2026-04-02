/**
 * Scene builders for each poker phase.
 * Each receives (bot, ctx) where ctx = { allBots, state, worldConfig, phase, log }
 */

import { formatCards } from './logic.js';
import { getBlinds } from './game.js';

// --- Shared helpers ---

function playerLine(name, chips, bet, folded, isDealer, isActive) {
  let line = `- **${name}** — ${chips} chips`;
  if (bet > 0) line += ` (bet: ${bet})`;
  if (folded) line += ' *(folded)*';
  if (isDealer) line += ' 🎲';
  if (isActive) line += ' ← acting';
  return line;
}

function buildPlayerSection(bot, state) {
  const lines = [];
  const hand = state.hand;
  const seats = hand.seats;

  for (const seat of seats) {
    const isMe = seat.botName === bot.name;
    const p = hand.players[seat.botName];
    const isDealer = seat.botName === seats[hand.dealerIndex]?.botName;
    const isActive = seat.botName === hand.activePlayer;
    lines.push(playerLine(
      isMe ? `${seat.displayName} (you)` : seat.displayName,
      p.chips,
      p.bet,
      p.folded,
      isDealer,
      isActive,
    ));
  }
  return lines;
}

function buildActionInfo(bot, state) {
  const hand = state.hand;
  const p = hand.players[bot.name];
  if (!p || p.folded) return [];

  const lines = [];
  const toCall = hand.currentBet - p.bet;

  if (hand.activePlayer === bot.name) {
    lines.push('');
    lines.push('### Your turn');
    if (toCall > 0) {
      lines.push(`Current bet: **${hand.currentBet}** (${toCall} to call)`);
      lines.push(`Options: **poker_call**, **poker_raise**, **poker_fold**`);
    } else {
      lines.push(`No bet to match.`);
      lines.push(`Options: **poker_check**, **poker_raise**, **poker_fold**`);
    }
    lines.push(`Min raise: **${Math.max(hand.currentBet * 2, hand.bigBlind)}**`);
  }
  return lines;
}

function recentChat(log) {
  const chats = log.filter(e => e.action === 'say').slice(-5);
  if (chats.length === 0) return [];
  return ['', '### Table talk', ...chats.map(e => `- **${e.displayName}:** ${e.message}`)];
}

// --- Phase scene builders ---

export function waitingScene(bot, ctx) {
  const { state, log } = ctx;
  const lines = [
    '## 🃏 Poker Table — Waiting for players',
    '',
    `Players at the table: ${state.bots.length}`,
    `Need at least 2 to start.`,
  ];
  if (state.bots.length >= 2) {
    lines.push('', '*A new hand will start next tick.*');
  }
  lines.push(...recentChat(log));
  return lines.join('\n');
}

export function bettingScene(bot, ctx) {
  const { state, log } = ctx;
  const hand = state.hand;
  const p = hand.players[bot.name];

  const streetNames = { preflop: 'Pre-Flop', flop: 'Flop', turn: 'Turn', river: 'River' };
  const streetName = streetNames[hand.street] || hand.street;

  const blinds = getBlinds(state.handsPlayed);
  const blindLabel = blinds.level > 0 ? ` (Level ${blinds.level + 1}: ${blinds.small}/${blinds.big})` : '';

  const lines = [
    `## 🃏 Poker Table — ${streetName}`,
    '',
    `**Pot:** ${hand.pot} | **Blinds:** ${hand.smallBlind}/${hand.bigBlind}${blindLabel}`,
  ];

  // Community cards
  if (hand.community.length > 0) {
    lines.push(`**Board:** ${formatCards(hand.community)}`);
  }
  lines.push('');

  // Your hole cards (private — only you see this)
  if (!p) {
    lines.push('*You joined mid-hand — watching this round. You will be dealt in next hand.*');
    lines.push('');
  } else if (p.folded) {
    lines.push('*You folded this hand.*');
    lines.push('');
  } else {
    lines.push(`### Your Hand`);
    lines.push(`**${formatCards(p.cards)}**`);
    lines.push('');
  }

  // Players
  lines.push('### Players');
  lines.push(...buildPlayerSection(bot, state));

  // Action info
  lines.push(...buildActionInfo(bot, state));

  // Full action history for this hand
  const handActions = log.filter(e => e.action !== 'say' && e.tick >= hand.startTick);
  if (handActions.length > 0) {
    lines.push('', '### Hand history');
    for (const e of handActions) {
      lines.push(`- **${e.displayName}** ${describeAction(e)}`);
    }
  }

  lines.push(...recentChat(log));

  return lines.join('\n');
}

export function showdownScene(bot, ctx) {
  const { state, log } = ctx;
  const hand = state.hand;

  const lines = [
    '## 🃏 Poker Table — Showdown',
    '',
    `**Pot:** ${hand.pot}`,
    `**Board:** ${formatCards(hand.community)}`,
    '',
  ];

  // Show everyone's cards at showdown
  if (hand.result) {
    lines.push('### Results');
    for (const ev of hand.result.evaluations) {
      const p = hand.players[ev.botName];
      const isWinner = hand.result.winners.includes(ev.botName);
      const seat = hand.seats.find(s => s.botName === ev.botName);
      const name = seat?.displayName || ev.botName;
      if (p.folded) {
        lines.push(`- **${name}** — folded`);
      } else {
        lines.push(`- **${name}** — ${formatCards(p.cards)} → *${ev.hand}*${isWinner ? ' 🏆' : ''}`);
      }
    }
    lines.push('');
    const winnerNames = hand.result.winners.map(w => hand.seats.find(s => s.botName === w)?.displayName || w);
    const share = Math.floor(hand.pot / hand.result.winners.length);
    lines.push(`**Winner${winnerNames.length > 1 ? 's' : ''}:** ${winnerNames.join(', ')} — ${hand.result.handName} (${share} chips each)`);
  }

  // Full action history for this hand (useful for post-hand analysis / journaling)
  const handActions = log.filter(e => e.action !== 'say' && e.action !== 'result' && e.tick >= hand.startTick);
  if (handActions.length > 0) {
    lines.push('', '### Hand history');
    for (const e of handActions) {
      lines.push(`- **${e.displayName}** ${describeAction(e)}`);
    }
  }

  lines.push('', '*Next hand starting soon.*');
  lines.push(...recentChat(log));

  return lines.join('\n');
}

export function finishedScene(bot, ctx) {
  const { state, log } = ctx;
  const winner = state.winner;

  const lines = [
    '## 🃏 Poker Table — Game Over',
    '',
  ];

  if (winner) {
    lines.push(`**${winner.displayName}** wins the game with **${winner.chips} chips** after ${winner.handsPlayed} hands!`);
    lines.push('');

    // Show final chip counts for all players
    lines.push('### Final Standings');
    const standings = state.bots
      .map(b => ({ name: state.remoteParticipants?.[b]?.displayName || b, chips: state.buyIns[b] || 0 }))
      .sort((a, b) => b.chips - a.chips);
    for (const s of standings) {
      lines.push(`- **${s.name}** — ${s.chips} chips`);
    }
  }

  lines.push('', '*Waiting for players to leave or join to start a new game.*');
  lines.push(...recentChat(log));

  return lines.join('\n');
}

function describeAction(entry) {
  switch (entry.action) {
    case 'check': return 'checks';
    case 'call': return `calls ${entry.amount || ''}`.trim();
    case 'raise': return `raises to ${entry.amount}`;
    case 'fold': return 'folds';
    case 'blind': return `posts ${entry.blindType} blind (${entry.amount})`;
    case 'deal': return entry.message || 'deals';
    case 'deal_hole': return 'is dealt cards';
    default: return entry.action;
  }
}
