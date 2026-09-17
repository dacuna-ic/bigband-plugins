import { Surreal, type Table } from 'surrealdb';
export declare const db: Surreal;
export declare const surrealDBConnection: BigbandDatabaseConnection;
export declare const surrealDBAddress: string;
export interface Migration {
    /** A monotonically increasing identifier; once applied, a version is immutable. */
    version: number;
    /** SurrealQL statements to run atomically for this version. */
    query: string;
}
/**
 * Apply immutable, ordered migrations exactly once in the shared database.
 *
 * Each version is recorded in `_bigband_migrations` and applied in an
 * explicit transaction. The record's unique key makes concurrent calls from
 * a hot-reloaded WebView wait for the winner instead of executing the same
 * schema statements twice. Failed transactions leave no marker, so a later
 * reload can safely retry them.
 *
 * Keep a version's query unchanged after it has shipped; add a new version for
 * every subsequent schema change. Queries must contain statements only, not
 * their own BEGIN/COMMIT block.
 */
export declare function migrate(plugin: string, migrations: readonly Migration[]): Promise<void>;
export declare function useCollection<Row = unknown>(tables: Table | Table[], query: string, { vars }?: {
    vars?: Record<string, unknown>;
}): {
    rows: Row[] | null;
    error: string | null;
};
