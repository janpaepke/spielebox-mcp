import { Contact } from "@janpaepke/spielebox-client";
import { inputRequired } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { ConsentAnswer, ConsentChannel, ConsentOutcome, ConsentRequest } from "./types.ts";
import { CONFIRM_LABEL, HEADING, ORDER_FORM_CONSENT, PICKUP_NOTE } from "./wording.ts";

/** Consent through an elicitation form rendered by the MCP client (e.g. Claude Code). */
export class FormConsentChannel implements ConsentChannel {
  readonly name = "form";

  supports(elicitation: { form: boolean }): boolean {
    return elicitation.form;
  }

  async ask(request: ConsentRequest) {
    const titles = request.titles.map((t) => `• ${t}`).join("\n");
    return {
      input: inputRequired.elicit({
        message: `${HEADING}:\n${titles}\n\n${PICKUP_NOTE}\n\nMit dem Absenden wird im Formular der Spielebox bestätigt: „${ORDER_FORM_CONSENT}“`,
        requestedSchema: formSchema(request.contact),
      }),
    };
  }

  async collect(answer: ConsentAnswer, request: ConsentRequest): Promise<ConsentOutcome> {
    if (answer.kind !== "elicit") return { granted: false, reason: "The client sent no answer." };
    if (answer.action !== "accept") {
      return { granted: false, reason: `The user ${answer.action === "decline" ? "declined" : "cancelled"}.` };
    }
    // The answer comes from the client and is untrusted: validate it against the schema that was asked.
    const parsed = formSchema(request.contact).safeParse(answer.content ?? {});
    const content = parsed.success ? parsed.data : undefined;
    if (!content?.confirm) return { granted: false, reason: "The user did not tick the confirmation box." };
    const contact = Contact.safeParse({
      firstName: content.firstName,
      lastName: content.lastName,
      email: content.email,
      phone: content.phone || undefined,
    });
    if (!contact.success) return { granted: false, reason: `Invalid contact data: ${z.prettifyError(contact.error)}` };
    return { granted: true, contact: contact.data };
  }
}

/** A required confirmation plus the contact fields of the catalog's order form, prefilled. */
function formSchema(defaults: Partial<Contact>) {
  const text = (title: string, value: string | undefined) =>
    value ? z.string().meta({ title }).default(value) : z.string().meta({ title });
  return z.object({
    confirm: z.boolean().meta({ title: CONFIRM_LABEL }).default(false),
    firstName: text("Vorname", defaults.firstName),
    lastName: text("Nachname", defaults.lastName),
    email: text("E-Mail", defaults.email),
    phone: text("Telefon (optional)", defaults.phone).optional(),
  });
}
