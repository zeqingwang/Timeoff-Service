/**
 * TypeORM column transformer for decimal columns stored as strings in SQLite.
 * Kept in one place so branches are covered by unit tests.
 */
export const decimalColumnTransformer = {
  to: (v: number | string): number | string => v,
  from: (v: string | null): number | null =>
    v === null ? null : parseFloat(v),
};
