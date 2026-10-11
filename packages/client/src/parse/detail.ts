import { MarkupChangedError } from "../errors.ts";
import { ONLINE_RESERVATION_NOTE } from "../opac.ts";
import { type Availability, type Copy, GameDetails } from "../schema.ts";
import { clean, type Page } from "./page.ts";
import { statusFromIcon } from "./search.ts";
import { parseAgeFrom, parseDurationRange, parsePlayers, parseYear, splitAuthors, splitKeywords } from "./values.ts";

const AVAILABILITY_RANK: Availability[] = ["available", "on_site_only", "borrowed", "unknown"];

/**
 * Parses a detail page (`index.php?media=<id>`). Returns null if the page is the session error box,
 * i.e. the id wasn't in the session's last result set.
 */
export function parseDetailPage($: Page, id: string, asOf: Date): GameDetails | null {
  const root = $("#details_sb");
  if (!root.length) {
    if ($("#errorbox").length) return null;
    throw new MarkupChangedError("detail page without #details_sb");
  }

  const fields = new Map<string, string>();
  let copies: Copy[] = [];
  for (const left of root.children(".leftdetail").toArray()) {
    const label = clean($(left).text());
    const right = $(left).next(".rightdetail");
    if (label === "Mediennummer(n)") copies = parseCopies($, right.html() ?? "");
    else fields.set(label, clean(right.text()));
  }

  const opt = <T>(key: string, parse: (v: string) => T): T | null => {
    const v = fields.get(key);
    return v ? parse(v) : null;
  };
  const availability = AVAILABILITY_RANK.find((a) => copies.some((c) => c.availability === a)) ?? "unknown";

  const game = {
    id,
    title: clean(root.children("h1").first().text()),
    availability,
    authors: splitAuthors(fields.get("AutorIn") ?? ""),
    publisher: fields.get("Verlag") || null,
    year: opt("Erscheinungsjahr", parseYear),
    ageFrom: opt("Alterseignung", parseAgeFrom),
    durationMinutes: opt("Spieldauer", parseDurationRange),
    players: opt("SpielerInnen", parsePlayers),
    description: fields.get("Beschreibung") || null,
    keywords: splitKeywords(fields.get("Schlagworte") ?? "").items,
    onlineReservationRequired: (fields.get("Hinweis") ?? "").includes(ONLINE_RESERVATION_NOTE),
    copies,
    availableCopies: copies.filter((c) => c.availability === "available").length,
    asOf: asOf.toISOString(),
  };
  const parsed = GameDetails.safeParse(game);
  if (!parsed.success) throw new MarkupChangedError(`detail page ${id}`, { cause: parsed.error });
  return parsed.data;
}

/** `54559<img src="img/status_green.gif" …/>54612<img …/>` → copies */
function parseCopies($: Page, html: string): Copy[] {
  const copies = [...html.matchAll(/(\d+)\s*(<img[^>]*>)/g)].map(([, copyNo, img]) => ({
    copyNo: copyNo ?? "",
    availability: statusFromIcon($(img ?? "").attr("src")),
  }));
  if (!copies.length) throw new MarkupChangedError("detail page without copies");
  return copies;
}
