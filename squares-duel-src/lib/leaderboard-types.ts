export type LeaderboardEntry = {
  rank: number;
  position: number;
  username: string;
  rating: number;
  ratedGames: number;
  isMe: boolean;
};

export type LeaderboardProfile = Omit<LeaderboardEntry, 'rank' | 'position' | 'isMe'> & {
  rank: number | null;
  position: number | null;
  isMe: true;
};

export type Leaderboard = {
  entries: LeaderboardEntry[];
  total: number;
  offset: number;
  limit: number;
  me: LeaderboardProfile;
  generatedAt: number;
};

export type LeaderboardResponse = Leaderboard;
