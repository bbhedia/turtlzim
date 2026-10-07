// Dialogs, on the browser's own <dialog> element: it traps focus, closes on Escape and dims the page
// behind it. A dialog checks its fields as the person types, and when it is confirmed it can refuse
// (the notebook rules say a name is taken, say) and stay open with the reason.
import { clear, h } from "./dom";
import type { Child } from "./dom";

export interface Field {
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  /** `password` hides what is typed (and keeps the browser from offering to spell-check it). */
  type?: "text" | "password";
  /** What a password manager should make of the field, for a `password`: a new one, or the current one. */
  autocomplete?: "new-password" | "current-password";
  /** A problem with the current value, as a message to show, or null if it's fine. `values` is what every field holds now. */
  validate?: (value: string, values: Record<string, string>) => string | null;
}

export interface Check {
  name: string;
  label: string;
  checked?: boolean;
}

export interface Choice {
  name: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
}

export interface DialogOptions {
  title: string;
  /** Paragraphs or elements shown under the title. */
  body?: Child[];
  fields?: Field[];
  checks?: Check[];
  choices?: Choice[];
  confirm: string;
  /** A destructive action: the confirm button looks the part and isn't the default. */
  danger?: boolean;
  /** Without a cancel button (a message): the only button is `confirm`. */
  noCancel?: boolean;
  /** Further buttons, next to Cancel; `close` ends the dialog as a cancel does. */
  actions?: Array<{ label: string; run: (close: () => void) => void }>;
  /** What the confirm button says while `submit` is working (it can take a moment). */
  working?: string;
  /**
   * Called when the dialog is confirmed with what was entered. Return (or throw) a message to keep
   * the dialog open and show it; return nothing to close it.
   */
  submit?: (values: Record<string, string | boolean>) => Promise<string | void> | string | void;
}

/** Show a dialog. Resolves true if it was confirmed (and `submit` was happy), false if dismissed. */
export function showDialog(options: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = h("dialog", { class: "dialog", "aria-labelledby": "dialog-title" });
    const errorLine = h("p", { class: "dialog-error", role: "alert" });
    const confirmButton = h("button", { type: "submit", class: options.danger ? "danger" : "primary", text: options.confirm });
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    const problems = new Map<string, HTMLElement>();

    const form = h("form", { method: "dialog", class: "dialog-form" }, h("h2", { id: "dialog-title", text: options.title }), ...(options.body ?? []).map((c) => (typeof c === "string" ? h("p", { text: c }) : c)));

    const textValues = (): Record<string, string> => {
      const values: Record<string, string> = {};
      for (const field of options.fields ?? []) values[field.name] = (inputs.get(field.name) as HTMLInputElement).value;
      return values;
    };

    /** The fields a person has typed in: a field they haven't reached yet is not scolded for being empty (though the dialog can't be confirmed until it is right). */
    const touched = new Set<string>();

    const refresh = (): boolean => {
      let valid = true;
      const values = textValues();
      for (const field of options.fields ?? []) {
        const input = inputs.get(field.name) as HTMLInputElement;
        const problem = field.validate ? field.validate(input.value, values) : null;
        const slot = problems.get(field.name)!;
        const shown = problem !== null && (touched.has(field.name) || input.value !== "");
        slot.textContent = shown ? problem : "";
        input.setAttribute("aria-invalid", shown ? "true" : "false");
        if (problem) valid = false;
      }
      confirmButton.disabled = !valid;
      return valid;
    };

    for (const field of options.fields ?? []) {
      const id = `field-${field.name}`;
      const input = h("input", { id, type: field.type ?? "text", value: field.value ?? "", placeholder: field.placeholder, autocomplete: field.autocomplete ?? "off", spellcheck: "false", autocapitalize: "off", on: { input: () => { errorLine.textContent = ""; touched.add(field.name); refresh(); } } });
      const problem = h("span", { class: "field-problem", "aria-live": "polite" });
      inputs.set(field.name, input);
      problems.set(field.name, problem);
      form.append(h("div", { class: "field" }, h("label", { for: id, text: field.label }), input, field.hint ? h("span", { class: "field-hint", text: field.hint }) : null, problem));
    }
    for (const choice of options.choices ?? []) {
      const select = h("select", { id: `choice-${choice.name}` }, ...choice.options.map((o) => h("option", { value: o.value, text: o.label, selected: o.value === choice.value })));
      inputs.set(choice.name, select);
      form.append(h("div", { class: "field" }, h("label", { for: select.id, text: choice.label }), select));
    }
    for (const check of options.checks ?? []) {
      const box = h("input", { type: "checkbox", id: `check-${check.name}`, checked: check.checked ?? false });
      inputs.set(check.name, box);
      form.append(h("label", { class: "check-row", for: box.id }, box, " ", check.label));
    }
    const extra = (options.actions ?? []).map((action) => h("button", { type: "button", class: "secondary", text: action.label, on: { click: () => action.run(() => dialog.close("cancel")) } }));
    form.append(errorLine, h("div", { class: "dialog-buttons" }, ...extra, options.noCancel ? null : h("button", { type: "button", class: "secondary", text: "Cancel", on: { click: () => dialog.close("cancel") } }), confirmButton));

    let working = false;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (working || !refresh()) return;
      working = true;
      confirmButton.disabled = true;
      if (options.working) confirmButton.textContent = options.working;
      const values: Record<string, string | boolean> = {};
      for (const [name, input] of inputs) values[name] = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
      let problem: string | void;
      try {
        problem = await options.submit?.(values);
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      working = false;
      confirmButton.textContent = options.confirm;
      if (problem) {
        errorLine.textContent = problem;
        refresh();
        return;
      }
      dialog.close("ok");
    });

    dialog.append(form);
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue === "ok");
    });
    document.body.append(dialog);
    dialog.showModal();
    refresh();
    const first = [...inputs.values()].find((i) => i instanceof HTMLInputElement && (i.type === "text" || i.type === "password")) as HTMLInputElement | undefined;
    if (first) {
      first.focus();
      // select the part of a name a person is most likely to change: everything after the last colon
      const colon = first.value.lastIndexOf(":");
      first.setSelectionRange(colon + 1, first.value.length);
    } else confirmButton.focus();
  });
}

/** A message with an OK button. */
export function showMessage(title: string, ...paragraphs: Child[]): Promise<boolean> {
  return showDialog({ title, body: paragraphs, confirm: "OK", noCancel: true });
}

/** Re-exported so callers can empty a container with the same helper. */
export { clear };
