// The encrypted notebooks, kept on the account server. What is sent is the vault's own backup (`Vault.exportBackup`): one file with everything in the encrypted
// notebooks, still sealed by the vault's keys, which only the notebooks' passphrase opens. So the server holds an opaque file (and knows its size and when it was sent) and no new
// way of encrypting exists: the same engine, the same passphrase. It is a copy of one moment that replaces the one before, not a sync: a backup is restored where there
// is no vault, and nothing is merged (docs/zim-encrypted-notebooks.md, *Backup and restore*). Nothing of it is kept in the browser, and what the screen says names nothing.
import { showDialog } from "../app/dialogs";
import { ApiError } from "./client";
import type { RemoteNotebook, WireFile } from "./client";
import type { AccountUi } from "./ui";

/** The id of the sealed copy among the account's notebooks (the list of notebooks that can be opened leaves it out). */
export const SEALED_ID = "sealed-vault-v1";
const SEALED_PATH = "vault.zimvault";

export interface SealedHost {
  say(text: string): void;
  /** The encrypted notebooks are unlocked. */
  unlocked(): boolean;
  /** This browser has encrypted notebooks (locked or not): a backup is only restored where there are none. */
  hasVault(): boolean;
  /** What is typed has reached the vault; false if it could not be waited for. */
  settle(): Promise<boolean>;
  /** The backup file of the unlocked vault. */
  backup(): Promise<Blob>;
  /** The restore flow of the app, with a backup it was given (asks to confirm, puts it back, then asks for the passphrase). */
  restore(file: Blob, label: string): Promise<void>;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const kilobytes = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

export class SealedUi {
  constructor(
    private readonly host: SealedHost,
    private readonly account: AccountUi,
  ) {}

  /** The lines of the menu. */
  menu(): Array<{ label: string; run: () => void }> {
    if (!this.account.account) return [];
    if (this.host.unlocked()) return [{ label: "Back up the encrypted notebooks to the server…", run: () => void this.backupDialog() }];
    if (!this.host.hasVault()) return [{ label: "Restore the encrypted notebooks from the server…", run: () => void this.restoreDialog() }];
    return [];
  }

  private async existing(): Promise<{ remote: RemoteNotebook | undefined; quota: number; used: number }> {
    const list = await this.account.client.listNotebooks();
    return { remote: list.notebooks.find((n) => n.id === SEALED_ID), quota: list.quotaBytes, used: list.usedBytes };
  }

  private async backupDialog(): Promise<void> {
    if (!this.host.unlocked()) return;
    let state;
    try {
      state = await this.existing();
    } catch (error) {
      this.host.say(`Couldn't ask the server: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const kept = await this.host.settle();
    const { remote } = state;
    await showDialog({
      title: "Back up the encrypted notebooks to the server",
      body: [
        "The server keeps one file with everything in the encrypted notebooks, still encrypted here, in this browser, before it is sent. The server can't read it: it sees that the file exists, how big it is and when it was sent.",
        h2("It opens with the passphrase the notebooks have now (a passphrase that you change later does not change a copy that was sent before). Whoever runs the server could try to guess that passphrase, at a cost of 128 MiB of memory a try, so use a long one."),
        h2("If you forget the passphrase, this copy and the notebooks are lost for good: nobody, the server included, can recover it."),
        h2(remote ? `It replaces the copy that is on the server (sent ${new Date(remote.updatedAt * 1000).toLocaleString()}, ${kilobytes(remote.bytes ?? 0)}). It is a copy of this moment: what you write afterwards is sent next time you do this. To put it back on another computer, choose “Restore the encrypted notebooks from the server…” there.` : "It is a copy of this moment: what you write afterwards is sent next time you do this. To put it back on another computer, choose “Restore the encrypted notebooks from the server…” there."),
        ...(kept ? [] : [h2("What you typed last has not reached the encrypted notebook, so it is not in the copy.")]),
      ],
      confirm: "Send the sealed copy",
      working: "Sending…",
      actions: remote ? [{ label: "Delete the copy on the server", run: (close) => (close(), void this.deleteCopy()) }] : [],
      submit: async () => {
        try {
          const file = await this.host.backup();
          const bytes = new Uint8Array(await file.arrayBuffer());
          // (the server is told the revision the person was shown: a copy sent from another computer meanwhile is not replaced without being seen)
          await this.account.client.putNotebook(SEALED_ID, { title: "Encrypted notebooks (sealed)", baseRevision: remote?.revision ?? 0, files: [{ path: SEALED_PATH, base64: bytesToBase64(bytes) }] });
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) return "A copy was sent from another computer while this was open. Close this and try again, to see it.";
          return error instanceof Error ? error.message : String(error);
        }
        this.host.say("The sealed copy of the encrypted notebooks was sent to the server.");
      },
    });
  }

  private async deleteCopy(): Promise<void> {
    try {
      await this.account.client.deleteNotebook(SEALED_ID);
    } catch (error) {
      this.host.say(`Couldn't delete it: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.host.say("The sealed copy was deleted from the server.");
  }

  private async restoreDialog(): Promise<void> {
    let state;
    try {
      state = await this.existing();
    } catch (error) {
      this.host.say(`Couldn't ask the server: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const remote = state.remote;
    if (!remote) {
      await showDialog({ title: "Encrypted notebooks on the server", body: ["There is no sealed copy on the server yet. On the computer that has the encrypted notebooks, unlock them and choose “Back up the encrypted notebooks to the server…”."], confirm: "Close", noCancel: true });
      return;
    }
    let file: WireFile | undefined;
    try {
      file = (await this.account.client.getNotebook(SEALED_ID)).files.find((f) => f.path === SEALED_PATH);
    } catch (error) {
      this.host.say(`Couldn't fetch it: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!file) {
      this.host.say("The copy on the server is not a sealed copy of encrypted notebooks.");
      return;
    }
    await this.host.restore(new Blob([base64ToBytes(file.base64) as BlobPart]), `the copy on the server (sent ${new Date(remote.updatedAt * 1000).toLocaleString()})`);
  }
}

function h2(text: string): HTMLElement {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}
