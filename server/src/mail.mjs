// Sending e-mail, behind one small interface (`send({ to, subject, text })`) so that the way it is sent can change: an outbox file for development and tests (nothing leaves the
// machine), or SMTP for real (any provider: the server of a host, a transactional service).
import { appendFileSync } from "node:fs";

export class OutboxMailer {
  /** @param {string} [file] where each message is also written, one JSON object a line */
  constructor(file) {
    this.file = file;
    /** @type {Array<{ to: string, subject: string, text: string, at: number }>} */
    this.sent = [];
  }

  async send(message) {
    const entry = { ...message, at: Date.now() };
    this.sent.push(entry);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }
}

export class SmtpMailer {
  constructor({ from, smtp }) {
    this.from = from;
    this.smtp = smtp;
    this.transport = null;
  }

  async send({ to, subject, text }) {
    if (!this.transport) {
      const { createTransport } = await import("nodemailer");
      this.transport = createTransport({ host: this.smtp.host, port: this.smtp.port, secure: this.smtp.secure, auth: this.smtp.user ? { user: this.smtp.user, pass: this.smtp.pass } : undefined });
    }
    await this.transport.sendMail({ from: this.from, to, subject, text });
  }
}

export function createMailer(mail) {
  return mail.driver === "smtp" ? new SmtpMailer(mail) : new OutboxMailer(mail.outbox);
}

export const messages = {
  confirmation: (code, minutes) => ({
    subject: "Your Zim Notebook confirmation code",
    text: `Your confirmation code is ${code}\n\nIt is valid for ${minutes} minutes. If you did not ask for an account on Zim Notebook, ignore this message: nothing was created without this code.\n`,
  }),
  alreadyRegistered: () => ({
    subject: "Zim Notebook: you already have an account",
    text: "Someone (you, we hope) tried to create a Zim Notebook account with this address, which already has one.\n\nSign in with your password, or choose \"Forgot your password\" to get a code to set a new one. If it was not you, ignore this message.\n",
  }),
  reset: (code, minutes) => ({
    subject: "Your Zim Notebook password reset code",
    text: `Your code to choose a new password is ${code}\n\nIt is valid for ${minutes} minutes. If you did not ask for it, ignore this message: your password has not changed.\n`,
  }),
};
