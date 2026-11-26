import { z } from 'zod';

/** One entry in a pairing's conversation. seq counts per kind: instruction #1, #2…, report #1, #2… */
export const Message = z.object({
  kind: z.enum(['instruction', 'report']),
  seq: z.number().int().positive(),
  at: z.string(),
  text: z.string(),
  /** reports only: the instruction seq the page showed when the report was sent */
  about: z.number().int().nonnegative().optional(),
});
export type Message = z.infer<typeof Message>;

export const Pairing = z.object({
  id: z.string(),
  name: z.string(),
  token: z.string(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  messages: z.array(Message),
  /** last report seq handed to the CLI's wait */
  cliCursor: z.number().int().nonnegative(),
  /** last instruction seq the browser page rendered */
  browserSeenSeq: z.number().int().nonnegative(),
  browserLastAt: z.string().nullable(),
  /** last time the browser did anything on the page: a load, a wait press, a wait returning, a report */
  browserActiveAt: z.string().nullable().default(null),
  /** wait presses since the last report (reset by a report); null for pairings made before this was counted */
  waitsSinceReport: z.number().int().nonnegative().nullable().default(null),
});
export type Pairing = z.infer<typeof Pairing>;

export const StateFile = z.object({ version: z.literal(1), pairings: z.array(Pairing) });

/** What the CLI API returns for a pairing (never the browser token, except from new/prompt). */
export const PairingView = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  instructions: z.number().int(),
  reports: z.number().int(),
  unreadReports: z.number().int(),
  cliCursor: z.number().int(),
  lastInstruction: Message.nullable(),
  lastReport: Message.nullable(),
  browserSeenSeq: z.number().int(),
  browserLastAt: z.string().nullable(),
  browserWaiting: z.boolean(),
  pickedUp: z.boolean(),
  /** new: never opened the page · waiting: a wait is held open · active: recently busy · idle: gone quiet, its chat turn probably ended */
  browserState: z.enum(['new', 'waiting', 'active', 'idle']),
  browserActiveAt: z.string().nullable(),
  /** seconds since browserActiveAt (null before the first visit) */
  browserQuietS: z.number().int().nullable(),
  waitsSinceReport: z.number().int().nullable(),
});
export type PairingView = z.infer<typeof PairingView>;

export const NewPairingResult = z.object({
  pairing: PairingView,
  url: z.string(),
  prompt: z.string(),
  relayPrompt: z.string(),
});

export const SendResult = z.object({ pairing: PairingView, instruction: Message });

export const WaitResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('report'), report: Message, skipped: z.number().int(), pairing: PairingView }),
  z.object({ status: z.literal('timeout'), pairing: PairingView }),
  z.object({ status: z.literal('closed'), pairing: PairingView }),
]);
export type WaitResult = z.infer<typeof WaitResult>;

export const ApiError = z.object({ error: z.object({ code: z.string(), message: z.string(), next: z.string() }) });
