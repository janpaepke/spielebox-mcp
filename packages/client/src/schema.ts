import * as z from "zod";

/**
 * Domain model and request parameters. These schemas are the contract of the client: parsers validate against them,
 * and the MCP server uses them as tool input/output schemas. Keep them JSON-Schema-compatible (no transforms, no Dates).
 */

export const MediaId = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .describe("Game id (32-char hex) as returned by search results");

export const Availability = z
  .enum(["available", "on_site_only", "borrowed", "unknown"])
  .describe("available: can be borrowed now · on_site_only: play on site only · borrowed: all copies out");
export type Availability = z.infer<typeof Availability>;

const IntRange = z.object({ min: z.int(), max: z.int() });

export const GameSummary = z.object({
  id: MediaId,
  title: z.string(),
  availability: Availability.describe("Availability of the best copy (any copy available → available)"),
  authors: z.array(z.string()),
  publisher: z.string().nullable(),
  year: z.int().nullable(),
  ageFrom: z.int().nullable().describe("Minimum age in years"),
  maxDurationMinutes: z.int().nullable().describe("Upper bound of the play time bucket"),
  players: IntRange.nullable(),
  description: z.string().nullable(),
  descriptionTruncated: z.boolean().describe("True if the catalog shortened the description; get_games has it in full"),
  keywords: z.array(z.string()),
  keywordsTruncated: z.boolean(),
  onlineReservationRequired: z
    .boolean()
    .describe('Catalog note "Dieser Titel muss online vorbestellt werden": must be reserved online before pickup'),
});
export type GameSummary = z.infer<typeof GameSummary>;

export const Copy = z.object({
  copyNo: z.string().describe("Mediennummer of the physical copy"),
  availability: Availability,
});
export type Copy = z.infer<typeof Copy>;

export const GameDetails = GameSummary.omit({
  descriptionTruncated: true,
  keywordsTruncated: true,
  maxDurationMinutes: true,
}).extend({
  durationMinutes: IntRange.nullable().describe("Play time range in minutes"),
  copies: z.array(Copy),
  availableCopies: z.int(),
  asOf: z.iso.datetime().describe("When availability was read from the catalog"),
});
export type GameDetails = z.infer<typeof GameDetails>;

export const SortOrder = z.enum(["title", "author", "year", "ageFrom", "classification"]);
export type SortOrder = z.infer<typeof SortOrder>;

export const SearchParams = z.object({
  term: z
    .string()
    .trim()
    .min(3)
    .describe(
      "Search term, at least 3 characters. Matched as a contiguous, case-insensitive substring of title, author, " +
        'description and keywords — no AND/OR, no wildcards ("die siedler" works, "catan kosmos" does not).',
    ),
  keyword: z
    .string()
    .optional()
    .describe('Catalog keyword (Schlagwort), e.g. "Kooperationsspiele", "ausgezeichnet". See list_filters.'),
  players: z.int().min(1).optional().describe("Only games playable with exactly this many players"),
  age: z.int().min(1).optional().describe("Only games suitable for this age (minimum age ≤ age)"),
  maxDuration: z.int().min(1).optional().describe("Only games whose play time bucket is ≤ this many minutes"),
  availableOnly: z.boolean().optional().describe("Only games with at least one copy available to borrow now"),
  sort: SortOrder.optional().describe("Ascending sort order; default is the catalog's title order"),
  limit: z.int().min(1).max(100).default(20),
  offset: z.int().min(0).default(0),
});
export type SearchParams = z.input<typeof SearchParams>;

export const SearchResult = z.object({
  total: z.int().describe("Number of matching games (after all filters)"),
  offset: z.int(),
  games: z.array(GameSummary),
  asOf: z.iso.datetime(),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const NewGamesParams = z.object({
  limit: z.int().min(1).max(100).default(20),
  offset: z.int().min(0).default(0),
});
export type NewGamesParams = z.input<typeof NewGamesParams>;

export const FacetValue = z.object({ label: z.string(), count: z.int() });
export type FacetValue = z.infer<typeof FacetValue>;

export const Filters = z.object({
  term: z.string(),
  total: z.int(),
  keywords: z.array(FacetValue),
  players: z.array(FacetValue),
  ageFrom: z.array(FacetValue),
  duration: z.array(FacetValue),
  years: z.array(FacetValue),
});
export type Filters = z.infer<typeof Filters>;

export const GetGamesParams = z.object({
  ids: z.array(MediaId).min(1).max(10).describe("Game ids from search results"),
});
export type GetGamesParams = z.input<typeof GetGamesParams>;

export const GetGamesResult = z.object({
  games: z.array(GameDetails),
  notFound: z
    .array(z.object({ id: z.string(), reason: z.string() }))
    .describe("Ids that couldn't be resolved, with the reason"),
});
export type GetGamesResult = z.infer<typeof GetGamesResult>;
