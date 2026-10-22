import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const rooms = sqliteTable('rooms', {
  code: text('code').primaryKey(),
  state: text('state').notNull(),
  revision: integer('revision').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});
export const gameRecords = sqliteTable('game_records', {
  id: text('id').primaryKey(),
  roomCode: text('room_code').notNull(),
  round: integer('round').notNull(),
  endedAt: integer('ended_at').notNull(),
  playerNames: text('player_names').notNull(),
  recordJson: text('record_json').notNull(),
}, table => [index('game_records_ended_at_idx').on(table.endedAt, table.id)]);
export const roomChat = sqliteTable('room_chat', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  roomCode: text('room_code').notNull(),
  roomCreatedAt: integer('room_created_at').notNull(),
  playerId: text('player_id').notNull(),
  clientId: text('client_id').notNull(),
  text: text('text').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => [
  index('room_chat_room_seq_idx').on(table.roomCode, table.roomCreatedAt, table.seq),
  uniqueIndex('room_chat_client_idx').on(table.roomCode, table.roomCreatedAt, table.playerId, table.clientId),
]);
export const roomChatRates = sqliteTable('room_chat_rates', {
  roomCode: text('room_code').notNull(),
  roomCreatedAt: integer('room_created_at').notNull(),
  playerId: text('player_id').notNull(),
  lastSentAt: integer('last_sent_at').notNull(),
}, table => [primaryKey({ columns: [table.roomCode, table.roomCreatedAt, table.playerId] })]);
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  usernameKey: text('username_key').notNull(),
  passwordHash: text('password_hash').notNull(),
  passwordVersion: integer('password_version').notNull().default(0),
  ratingMilli: integer('rating_milli').notNull().default(1_000_000),
  ratedGames: integer('rated_games').notNull().default(0),
  createdAt: integer('created_at').notNull(),
}, table => [
  uniqueIndex('accounts_username_key_idx').on(table.usernameKey),
  index('accounts_leaderboard_idx').on(sql`${table.ratingMilli} DESC`, table.usernameKey).where(sql`${table.ratedGames} > 0`),
]);
export const accountSessions = sqliteTable('account_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  passwordVersion: integer('password_version').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('account_sessions_account_idx').on(table.accountId), index('account_sessions_expiry_idx').on(table.expiresAt)]);
export const accountRates = sqliteTable('account_rates', {
  key: text('key').primaryKey(),
  windowStart: integer('window_start').notNull(),
  hits: integer('hits').notNull(),
}, table => [index('account_rates_window_idx').on(table.windowStart)]);
export const ratingRounds = sqliteTable('rating_rounds', {
  id: text('id').primaryKey(),
  receipt: text('receipt').notNull(),
  roomCode: text('room_code').notNull(),
  round: integer('round').notNull(),
  endedAt: integer('ended_at').notNull(),
  resultJson: text('result_json').notNull(),
});
export const ratingChanges = sqliteTable('rating_changes', {
  roundId: text('round_id').notNull().references(() => ratingRounds.id),
  accountId: text('account_id').notNull().references(() => accounts.id),
  playerId: text('player_id').notNull(),
  teamId: integer('team_id').notNull(),
  beforeMilli: integer('before_milli').notNull(),
  deltaMilli: integer('delta_milli').notNull(),
  afterMilli: integer('after_milli').notNull(),
}, table => [primaryKey({ columns: [table.roundId, table.accountId] }), index('rating_changes_account_idx').on(table.accountId)]);
