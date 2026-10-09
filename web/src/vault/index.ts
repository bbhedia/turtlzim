export { CoreClient, CoreError, WorkerTransport } from "./core-client";
export type { CoreTransport } from "./core-client";
export type { PassphraseChange, RestoredBackup, VaultEvent } from "./vault";
export {
  BACKUP_EXTENSION, BACKUP_MAGIC, BACKUP_TYPE, MAX_BACKUP_BYTES, MIN_PASSPHRASE_LENGTH, NoVaultError, NotABackupError, Vault, VaultBusyError, VaultExistsError, VaultUnavailableError,
  WrongPassphraseError, checkPassphrase, normalizePassphrase, vaultSupport,
} from "./vault";
