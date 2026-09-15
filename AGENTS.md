# AI ASSISTANT RULES & STRICT DIRECTIVES (CRITICAL)

## 🔒 PERMANENT LOCK: SQLITE & MONGODB DATABASE CONFIGURATION

The database architecture, synchronization logic, and configurations in this project are **PERMANENTLY LOCKED & HARDENED**.

### STRICT RULES FOR ALL AI AGENTS & ASSISTANTS:
1. **NO TOUCH ZONE**: Under NO circumstances should any AI modify, rewrite, optimize, refactor, replace, or touch:
   - `db_mongo.py` (The entire MongoDB synchronization and backup engine)
   - `mongo_config.json` (MongoDB connection URI)
   - The database layer (`get_db`, `init_db`, `sync_db_async`, `push_sqlite_to_mongo`, `pull_mongo_to_sqlite`) in `app.py`.
   - SQLite WAL mode pragmas and schema definitions.

2. **TRIPLE-CONFIRMATION REQUIREMENT (3 STAGES)**:
   - If a user or task explicitly requests ANY modification to MongoDB or SQLite settings/files, the AI **MUST NOT** make any edits immediately.
   - The AI must explicitly inform the user that this layer is **LOCKED BY OWNER PROTOCOL** and demand **3 distinct, consecutive user confirmations** in separate prompts before proceeding.
   - If 3 distinct confirmations are not received, editing is **COMPLETELY FORBIDDEN**.

3. **IMMUTABLE VARIABLES**:
   - `DB_MONGO_ENGINE_LOCKED = True`
   - `PERSISTENCE_SETTINGS_PERMANENT = True`

---

## 🎯 ZERO-SIDE-EFFECT & SURGICAL PRECISION DIRECTIVE (1000% PRESERVATION)

This rule governs **ALL** future tasks, edits, and modifications across the entire codebase:

1. **SURGICAL EDITING ONLY (EXACT SCOPE)**:
   - The AI must **ONLY** modify the exact element, CSS selector, function, or text requested by the user.
   - **DO NOT TOUCH, "OPTIMIZE", REFACTOR, REORGANIZE, OR CLEAN UP ANY UNRELATED CODE.**
   - Unrequested changes, stylistic "beautifications", or assumptions are **STRICTLY FORBIDDEN**.

2. **1000% EXISTING CODE INTEGRITY**:
   - Before applying ANY change, verify that adjacent code, duplicate selectors, or surrounding lines are left intact and never corrupted.
   - Never remove or overwrite existing working features, buttons, styling, functions, or UI elements unless explicitly commanded with: *"delete X"* or *"remove Y"*.

3. **VERIFICATION BEFORE REPORTING**:
   - After any edit, the AI must verify that syntax remains 100% valid (no orphan brackets, no dangling CSS properties, no unclosed tags, no syntax errors).
   - If a file has unsaved or cached conflicts, inspect exact disk state before writing.
