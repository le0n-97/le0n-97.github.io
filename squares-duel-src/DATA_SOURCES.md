# Squares rules and puzzle data

New rooms and rematches generate their letter layouts at runtime. The long-dice-v2 strategy randomly selects an ordinary 8-, 9- or 10-letter word (excluding S endings), places it along a random self-avoiding adjacent route, and fills the other squares from shuffled English letter dice with independent cryptographic rolls. A complete dictionary traversal finds every ordinary and Bonus word on each candidate board. Candidates must contain at least one ordinary word of 8+ letters, two of 7+ and three of 6+, while their complete ordinary-word count must fit the selected 30–40, 41–55 or 56–70 tier (30–70 for any). No words are removed to fit a tier, and generation never falls back to a stored board. The original 262 board signatures and the room's recent 64 signatures are excluded across rotations and reflections. Both the seed word and its route are newly randomized; this is not a bank of prebuilt layouts.

Generated rounds save their board, full word lists and generator/dictionary version in the room's private state, so later polls, submissions and settlement use the same dictionary. Dictionary answers and recent-board history are stripped from public responses while the round is in progress. Historical rooms keep their old round data until rematch.

The generated mode uses SCOWL 2020.12.07: **79,284 ordinary words** from levels up to 60, plus **167,865 Bonus words** from the level-70/80 increment. The selected categories include ordinary English plus American and British spellings and level-1 near-equal variants. Only lowercase ASCII words of 4–16 letters are accepted before uppercasing; proper names, uppercase-only entries, abbreviations, contractions and punctuation are excluded. Its accepted vocabulary may differ from the original game.

The pinned upstream archive is mirrored at <https://deb.debian.org/debian/pool/main/s/scowl/scowl_2020.12.07.orig.tar.gz>, with SHA-256 `5587667caa20c4891390c2d42dbb4d5c4c3f41bee77af1457ece3ba23fb859cc`. The official source and level descriptions are at <https://github.com/en-wl/wordlist/tree/rel-2020.12.07/scowl>. Rebuild with `node scripts/build-dictionary.mjs` or pass `--archive` for a locally saved copy. `data/dictionary-sources.json` records the 54 exact inputs, per-file hashes, output hashes, filtering and length distributions. The unchanged upstream Copyright text is retained in `public/dictionary-license.txt` and served at `/dictionary-license.txt`.

Rules were checked against the official game at <https://squares.org/> on 2026-10-15, including its **How to Play** and **FAQ** dialogs.

- A 4×4 game accepts words of at least four letters.
- Consecutive letters must touch horizontally, vertically, or diagonally.
- Each tile may be used only once within a word. Tiles may be used again in other words.
- A scoring word earns one point per letter.
- Bonus words are rare or archaic entries accepted by the puzzle but award zero points.
- The legacy `x5` puzzle field is used for the Word of the Day hint reward. It is not a score multiplier.

`lib/puzzles.ts` contains **262** distinct static official puzzle boards with their complete main and bonus word lists. The first ten entries (puzzle IDs 952–961) retain their original indices so existing stored rooms remain compatible. On 2026-10-15, another 252 historical boards were appended after validating every board, word and route. The selection is split into 61 boards with 30–40 main words, 104 with 41–55, and 97 with 56–70. There are 13,265 main-word entries and 8,667 bonus-word entries across the bank. Rotated or reflected versions of the same board count as a single puzzle.

They were retrieved from the same daily data endpoint used by the official web game:

<https://squares.org/api/v1/puzzle/daily?offset=952&cell=4>

The `offset` is the number of days since 2024-02-28, as calculated by the official client. The server returns two consecutive puzzles for the requested offset. Historical boards were read through the same public client data format and selected only when the complete word lists fit a supported tier; no words were truncated. These saved static boards now serve only historical rooms and are never selected for a new round. Original puzzle content remains attributable to Squares; no affiliation is implied.

A creating browser can submit up to 32 previously seen board signatures to avoid, recognized across rotations and reflections. Only visible board letters are remembered in the browser. The previous finite-catalogue selection logic is retained solely as a legacy utility; new-room and rematch code use the runtime generator.

Official interface assets inspected for rule verification:

- <https://squares.org/assets/App-DSVvNgoc.js> (help text and score calculation)
- <https://squares.org/assets/index-B_IY8nxE.js> (accepted-word handling and daily puzzle loader)

The official Letter counts help text unlocks starting-letter counts after **40% progress**, and describes a small count on each tile. The duel adapts this to all active players' combined count of main words across both teams: length counts are always visible, and per-tile starting counts unlock at `ceil(mainWordCount × 0.4)` (or settlement). Bonus words do not contribute to this threshold. The official wording was rechecked in the App asset above on 2026-10-16; the duel's threshold is deliberately expressed as a shared word count.

Each word has one stable canonical route: the first valid depth-first path in ascending original tile-index order. A remaining ordinary word contributes exactly one count to that route's starting square, even when other valid routes or duplicate letters exist. Rotation only changes the view. Postgame word inspection uses the same canonical route. Squares become grey when no remaining ordinary word's canonical route uses them. As in the original, Bonus words and alternate valid routes do not keep a square bright; grey squares remain selectable. This was verified on 2026-10-16 against the official entry script's `h2` path enumeration and `z4`/`a6` per-tile counters, and the App component's `depleted` styling. Only aggregate counts and availability flags are sent during play; word routes remain private until settlement.

The duel's shared word ownership, team play, player Commit action, and three-minute inactivity ending are the requested multiplayer additions. The October 15 update changes Bonus scoring to **one point per word regardless of length**, as requested, rather than the official zero-point rule. Clicking Commit is irreversible and prevents further submissions from that player. A fixed 60-second settlement deadline begins only when every player on either team has committed. Both teams completing Commit, exhaustion of all main words, or an earlier inactivity deadline can end the game sooner. The host manually starts each round after both teams have at least one player; team sizes may differ. Spectators cannot submit words or Commit, and room chat is available only before the round starts.
