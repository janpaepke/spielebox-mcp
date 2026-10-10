import type { Cheerio } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { MarkupChangedError } from "../errors.ts";
import { FACET_PARAMS, type FacetHeading, ONLINE_RESERVATION_NOTE, STATUS_ICONS } from "../opac.ts";
import { type Availability, GameSummary } from "../schema.ts";
import { clean, type Page } from "./page.ts";
import {
  parseAgeFrom,
  parseDurationBucket,
  parsePlayers,
  parseYear,
  splitAuthors,
  splitKeywords,
  trimDescription,
} from "./values.ts";

export type FacetLink = { label: string; count: number; param: string; id: string };
export type FacetGroups = Partial<Record<FacetHeading, FacetLink[]>>;

export type ResultPage = {
  games: GameSummary[];
  /** "Seite X von Y"; null on pages without a pager (e.g. printlist). */
  pager: { page: number; pages: number } | null;
  facets: FacetGroups;
};

export function parseResultPage($: Page): ResultPage {
  const games = $("#results > div[id^='mnr']")
    .toArray()
    .map((el) => parseHit($, $(el)));
  return { games, pager: parsePager($), facets: parseFacets($) };
}

/** Total hits, derived from the media-type facet (every game has exactly one); falls back to the hit count. */
export function totalFromFacets(facets: FacetGroups): number | null {
  const types = facets.Medienart;
  return types?.length ? types.reduce((sum, f) => sum + f.count, 0) : null;
}

export function statusFromIcon(src: string | undefined): Availability {
  const color = /status_(\w+)\.gif/.exec(src ?? "")?.[1];
  const status = color && STATUS_ICONS[color];
  if (!status) throw new MarkupChangedError(`status icon "${src}"`);
  return status;
}

function parseHit($: Page, hit: Cheerio<Element>): GameSummary {
  const id = (hit.attr("id") ?? "").slice(3);
  const body = hit.find(".rightcol_sb");
  const fields = new Map<string, string>();
  let authors: string[] = [];

  for (const p of body.children("p").toArray()) {
    const { leading, labeled } = readLabeled($, $(p));
    for (const [k, v] of labeled) fields.set(k, v);
    if (labeled.has("Verlag") && leading) authors = splitAuthors(leading);
  }

  const description = fields.get("Beschreibung");
  const desc = description ? trimDescription(description) : null;
  const keywords = splitKeywords(fields.get("Schlagworte") ?? "");
  const opt = <T>(key: string, parse: (v: string) => T): T | null => {
    const v = fields.get(key);
    return v ? parse(v) : null;
  };

  const game = {
    id,
    title: clean(body.find("h1 a").first().text()),
    availability: statusFromIcon(hit.find(".leftcol img[src*='status_']").attr("src")),
    authors,
    publisher: fields.get("Verlag") || null,
    year: opt("Erscheinungsjahr", parseYear),
    ageFrom: opt("Alterseignung", parseAgeFrom),
    maxDurationMinutes: opt("Spieldauer", parseDurationBucket),
    players: opt("SpielerInnen", parsePlayers),
    description: desc?.text ?? null,
    descriptionTruncated: desc?.truncated ?? false,
    keywords: keywords.items,
    keywordsTruncated: keywords.truncated,
    onlineReservationRequired: (fields.get("Hinweis") ?? "").includes(ONLINE_RESERVATION_NOTE),
  };
  const parsed = GameSummary.safeParse(game);
  if (!parsed.success) throw new MarkupChangedError(`search hit ${id}`, { cause: parsed.error });
  return parsed.data;
}

/**
 * Reads a paragraph like `<b>Author</b> - <b>Verlag:</b> X / <b>Erscheinungsjahr:</b> 2002`.
 * `<b>Label:</b>` starts a field; text up to the next label is its value. A leading unlabeled `<b>` is returned separately.
 */
function readLabeled($: Page, p: Cheerio<Element>): { leading: string | null; labeled: Map<string, string> } {
  const labeled = new Map<string, string>();
  let leading: string | null = null;
  let label: string | null = null;
  let value = "";
  const flush = () => {
    if (label) labeled.set(label, clean(value).replace(/^[-/\s]+|[-/\s]+$/g, ""));
  };
  for (const node of p.contents().toArray() as AnyNode[]) {
    const text = $(node).text();
    const isBold = node.type === "tag" && node.name === "b";
    if (isBold && clean(text).endsWith(":")) {
      flush();
      label = clean(text).slice(0, -1).trim();
      value = "";
    } else if (isBold && label === null && leading === null) {
      leading = clean(text);
    } else if (label !== null) {
      value += text;
    }
  }
  flush();
  return { leading: leading || null, labeled };
}

function parsePager($: Page): ResultPage["pager"] {
  const m = /Seite (\d+) von (\d+)/.exec($("#pagebrowser").text());
  return m ? { page: Number(m[1]), pages: Number(m[2]) } : null;
}

const FACET_LINK_TEXT = /^(.*) \((\d+)\)$/;
const RESET_LINK = "Alle";

function parseFacets($: Page): FacetGroups {
  const groups: FacetGroups = {};
  for (const head of $("#rightwrap .rightboxhead_sb").toArray()) {
    const heading = clean($(head).text()) as FacetHeading;
    const param = FACET_PARAMS[heading];
    if (!param) throw new MarkupChangedError(`facet heading "${heading}"`);
    const links: FacetLink[] = [];
    for (const a of $(head).next(".rightboxdetail_sb").find("a[href]").toArray()) {
      const text = clean($(a).text());
      const id = new URL($(a).attr("href") ?? "", "https://x/").searchParams.get(param);
      // An active facet shows a bold "Alle" link that resets it; it carries no facet id.
      if (!id && text === RESET_LINK) continue;
      const m = FACET_LINK_TEXT.exec(text);
      if (!m?.[1] || !id) throw new MarkupChangedError(`facet link "${text}"`);
      links.push({ label: m[1], count: Number(m[2]), param, id });
    }
    groups[heading] = links;
  }
  return groups;
}
