// The error that carries what a person may be told: a message, and the HTTP status that goes with it. (Its own file so that the modules that make one need not import each other.)

/** An error whose message may be shown to the person, with the HTTP status that goes with it. */
export class AccountError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
