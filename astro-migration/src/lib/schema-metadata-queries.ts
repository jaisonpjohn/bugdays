/** Read-only catalog queries. Export each result as CSV or JSON, then paste it into Schema Explorer. */
export const metadataQueries = {
  postgres: {
    label: 'PostgreSQL',
    columns: `SELECT c.table_schema, c.table_name, c.column_name, c.data_type,
       c.ordinal_position, c.is_nullable, c.column_default,
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage k
           ON k.constraint_catalog = tc.constraint_catalog
          AND k.constraint_schema = tc.constraint_schema
          AND k.constraint_name = tc.constraint_name
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND k.table_schema = c.table_schema
           AND k.table_name = c.table_name
           AND k.column_name = c.column_name
       ) THEN 'YES' ELSE 'NO' END AS is_primary_key
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE t.table_type = 'BASE TABLE'
  AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY c.table_schema, c.table_name, c.ordinal_position;`,
    foreignKeys: `SELECT k.table_schema, k.table_name, k.column_name,
       tc.constraint_name, k.ordinal_position,
       r.unique_constraint_schema AS foreign_table_schema,
       uk.table_name AS foreign_table_name,
       uk.column_name AS foreign_column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage k
  ON k.constraint_catalog = tc.constraint_catalog
 AND k.constraint_schema = tc.constraint_schema
 AND k.constraint_name = tc.constraint_name
JOIN information_schema.referential_constraints r
  ON r.constraint_catalog = tc.constraint_catalog
 AND r.constraint_schema = tc.constraint_schema
 AND r.constraint_name = tc.constraint_name
JOIN information_schema.key_column_usage uk
  ON uk.constraint_catalog = r.unique_constraint_catalog
 AND uk.constraint_schema = r.unique_constraint_schema
 AND uk.constraint_name = r.unique_constraint_name
 AND uk.ordinal_position = k.position_in_unique_constraint
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND k.table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY k.table_schema, k.table_name, tc.constraint_name, k.ordinal_position;`,
  },
  mysql: {
    label: 'MySQL / MariaDB',
    columns: `SELECT c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name,
       c.COLUMN_NAME AS column_name, c.COLUMN_TYPE AS data_type,
       c.ORDINAL_POSITION AS ordinal_position, c.IS_NULLABLE AS is_nullable,
       c.COLUMN_DEFAULT AS column_default, c.COLUMN_KEY AS column_key,
       c.COLUMN_COMMENT AS column_comment
FROM information_schema.COLUMNS c
JOIN information_schema.TABLES t
  ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION;`,
    foreignKeys: `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name,
       COLUMN_NAME AS column_name, CONSTRAINT_NAME AS constraint_name,
       ORDINAL_POSITION AS ordinal_position,
       REFERENCED_TABLE_SCHEMA AS foreign_table_schema,
       REFERENCED_TABLE_NAME AS foreign_table_name,
       REFERENCED_COLUMN_NAME AS foreign_column_name
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION;`,
  },
  sqlserver: {
    label: 'SQL Server',
    columns: `SELECT c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name,
       c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type,
       c.ORDINAL_POSITION AS ordinal_position, c.IS_NULLABLE AS is_nullable,
       c.COLUMN_DEFAULT AS column_default,
       CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_primary_key
FROM INFORMATION_SCHEMA.COLUMNS c
JOIN INFORMATION_SCHEMA.TABLES t
  ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
LEFT JOIN (
  SELECT k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME
  FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
  JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
    ON k.CONSTRAINT_CATALOG = tc.CONSTRAINT_CATALOG
   AND k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
   AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
) pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME
     AND pk.COLUMN_NAME = c.COLUMN_NAME
WHERE t.TABLE_TYPE = 'BASE TABLE'
ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION;`,
    foreignKeys: `SELECT s.name AS table_schema, t.name AS table_name,
       c.name AS column_name, fk.name AS constraint_name,
       fkc.constraint_column_id AS ordinal_position,
       rs.name AS foreign_table_schema, rt.name AS foreign_table_name,
       rc.name AS foreign_column_name
FROM sys.foreign_key_columns fkc
JOIN sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
JOIN sys.tables t ON t.object_id = fkc.parent_object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = t.object_id AND c.column_id = fkc.parent_column_id
JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN sys.columns rc ON rc.object_id = rt.object_id AND rc.column_id = fkc.referenced_column_id
ORDER BY s.name, t.name, fk.name, fkc.constraint_column_id;`,
  },
  oracle: {
    label: 'Oracle',
    columns: `SELECT c.OWNER AS table_schema, c.TABLE_NAME AS table_name,
       c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type,
       c.COLUMN_ID AS ordinal_position, c.NULLABLE AS is_nullable,
       c.DATA_DEFAULT AS column_default, cc.COMMENTS AS column_comment,
       CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_primary_key
FROM ALL_TAB_COLUMNS c
JOIN ALL_TABLES t ON t.OWNER = c.OWNER AND t.TABLE_NAME = c.TABLE_NAME
LEFT JOIN ALL_COL_COMMENTS cc
  ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME
 AND cc.COLUMN_NAME = c.COLUMN_NAME
LEFT JOIN (
  SELECT k.OWNER, k.TABLE_NAME, k.COLUMN_NAME
  FROM ALL_CONSTRAINTS con
  JOIN ALL_CONS_COLUMNS k
    ON k.OWNER = con.OWNER AND k.CONSTRAINT_NAME = con.CONSTRAINT_NAME
  WHERE con.CONSTRAINT_TYPE = 'P'
) pk ON pk.OWNER = c.OWNER AND pk.TABLE_NAME = c.TABLE_NAME
     AND pk.COLUMN_NAME = c.COLUMN_NAME
WHERE c.OWNER = USER
ORDER BY c.OWNER, c.TABLE_NAME, c.COLUMN_ID;`,
    foreignKeys: `SELECT k.OWNER AS table_schema, k.TABLE_NAME AS table_name,
       k.COLUMN_NAME AS column_name, fk.CONSTRAINT_NAME AS constraint_name,
       k.POSITION AS ordinal_position,
       rk.OWNER AS foreign_table_schema, rk.TABLE_NAME AS foreign_table_name,
       rk.COLUMN_NAME AS foreign_column_name
FROM ALL_CONSTRAINTS fk
JOIN ALL_CONS_COLUMNS k
  ON k.OWNER = fk.OWNER AND k.CONSTRAINT_NAME = fk.CONSTRAINT_NAME
JOIN ALL_CONSTRAINTS parent
  ON parent.OWNER = fk.R_OWNER AND parent.CONSTRAINT_NAME = fk.R_CONSTRAINT_NAME
JOIN ALL_CONS_COLUMNS rk
  ON rk.OWNER = parent.OWNER AND rk.CONSTRAINT_NAME = parent.CONSTRAINT_NAME
 AND rk.POSITION = k.POSITION
WHERE fk.CONSTRAINT_TYPE = 'R' AND fk.OWNER = USER
ORDER BY k.OWNER, k.TABLE_NAME, fk.CONSTRAINT_NAME, k.POSITION;`,
  },
  db2: {
    label: 'DB2',
    columns: `SELECT c.TABSCHEMA AS table_schema, c.TABNAME AS table_name,
       c.COLNAME AS column_name, c.TYPENAME AS data_type,
       c.COLNO + 1 AS ordinal_position, c.NULLS AS is_nullable,
       c.DEFAULT AS column_default,
       CASE WHEN k.COLNAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_primary_key
FROM SYSCAT.COLUMNS c
JOIN SYSCAT.TABLES t
  ON t.TABSCHEMA = c.TABSCHEMA AND t.TABNAME = c.TABNAME
LEFT JOIN SYSCAT.TABCONST pk
  ON pk.TABSCHEMA = c.TABSCHEMA AND pk.TABNAME = c.TABNAME AND pk.TYPE = 'P'
LEFT JOIN SYSCAT.KEYCOLUSE k
  ON k.TABSCHEMA = pk.TABSCHEMA AND k.TABNAME = pk.TABNAME
 AND k.CONSTNAME = pk.CONSTNAME AND k.COLNAME = c.COLNAME
WHERE c.TABSCHEMA = CURRENT SCHEMA AND t.TYPE = 'T'
ORDER BY c.TABSCHEMA, c.TABNAME, c.COLNO;`,
    foreignKeys: `SELECT fk.TABSCHEMA AS table_schema, fk.TABNAME AS table_name,
       child.COLNAME AS column_name, fk.CONSTNAME AS constraint_name,
       child.COLSEQ AS ordinal_position,
       parent.TABSCHEMA AS foreign_table_schema,
       parent.TABNAME AS foreign_table_name,
       parent.COLNAME AS foreign_column_name
FROM SYSCAT.TABCONST fk
JOIN SYSCAT.REFERENCES r
  ON r.TABSCHEMA = fk.TABSCHEMA AND r.TABNAME = fk.TABNAME
 AND r.CONSTNAME = fk.CONSTNAME
JOIN SYSCAT.KEYCOLUSE child
  ON child.TABSCHEMA = fk.TABSCHEMA AND child.TABNAME = fk.TABNAME
 AND child.CONSTNAME = fk.CONSTNAME
JOIN SYSCAT.KEYCOLUSE parent
  ON parent.TABSCHEMA = r.REFTABSCHEMA AND parent.TABNAME = r.REFTABNAME
 AND parent.CONSTNAME = r.REFKEYNAME AND parent.COLSEQ = child.COLSEQ
WHERE fk.TYPE = 'F' AND fk.TABSCHEMA = CURRENT SCHEMA
ORDER BY fk.TABSCHEMA, fk.TABNAME, fk.CONSTNAME, child.COLSEQ;`,
  },
  sqlite: {
    label: 'SQLite',
    columns: `SELECT 'main' AS table_schema, m.name AS table_name,
       x.name AS column_name, x.type AS data_type,
       x.cid + 1 AS ordinal_position,
       CASE WHEN x."notnull" = 1 THEN 'NO' ELSE 'YES' END AS is_nullable,
       x.dflt_value AS column_default, x.pk AS is_primary_key
FROM sqlite_schema m, pragma_table_xinfo(m.name) x
WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
  AND x.hidden = 0
ORDER BY m.name, x.cid;`,
    foreignKeys: `SELECT 'main' AS table_schema, m.name AS table_name,
       f."from" AS column_name, m.name || '_fk_' || f.id AS constraint_name,
       f.seq + 1 AS ordinal_position,
       'main' AS foreign_table_schema, f."table" AS foreign_table_name,
       f."to" AS foreign_column_name
FROM sqlite_schema m, pragma_foreign_key_list(m.name) f
WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
ORDER BY m.name, f.id, f.seq;`,
  },
} as const;

export type MetadataEngine = keyof typeof metadataQueries;
