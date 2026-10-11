import { MarkupChangedError, OpacMessageError } from "../errors.ts";
import { clean, type Page, readMessage } from "./page.ts";

export type OrderForm = {
  /** Hidden `order` token; changes on every render of the form. */
  token: string;
  items: { title: string; orderable: boolean }[];
};

/** Parses the order form (`index.php?orderbasket=true`). Throws OpacMessageError for the error box (e.g. empty Merkliste). */
export function parseOrderForm($: Page): OrderForm {
  const form = $("form[method='post']").first();
  // Without the form, the page explains why (e.g. empty Merkliste, more than 6 games).
  const message = readMessage($);
  if (message && !form.find("input[name='order']").length) throw new OpacMessageError(message.text);
  const token = form.find("input[name='order']").attr("value");
  if (!token || !form.find("input[name='firstname']").length) throw new MarkupChangedError("order form");
  const items = form
    .find(".basketlist .mbasket")
    .toArray()
    .map((el) => {
      const icon = $(el).nextAll(".obasket").first().find("img").attr("src") ?? "";
      if (!/\/(ok|notok)\.png$/.test(icon)) throw new MarkupChangedError(`order item marker "${icon}"`);
      return { title: clean($(el).text()), orderable: icon.endsWith("/ok.png") };
    });
  return { token, items };
}

export type OrderResponse = { accepted: true; message: string } | { accepted: false; message: string };

/**
 * Classifies the page returned after submitting the order form. The success page has not been recorded yet:
 * anything that is neither an error box nor the form again counts as accepted, and its text is passed on verbatim.
 */
export function parseOrderResponse($: Page): OrderResponse {
  const message = readMessage($);
  if (message?.kind === "error") return { accepted: false, message: message.text };
  if ($("input[name='firstname']").length) {
    return { accepted: false, message: clean($("#details_sb").text()) || "The order form was shown again" };
  }
  return { accepted: true, message: clean($("#content").text()) };
}
