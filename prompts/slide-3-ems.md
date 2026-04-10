# Slide 3: EMS — Entity Model System

## Style Brief

(Same as title slide — deep indigo/navy blueprint, white/cyan line art, amber-gold accents, hand-drafted quality.)

## Layout: Observer Pipeline with Ring Diagram

## Prompt

Architectural blueprint on deep indigo-navy paper with faint cyan grid lines, fold creases, and worn edges. White and light cyan chalk-like line work, hand-drafted quality. Amber-gold accents on pinned notes only. 16:9 aspect ratio. The feel of a process-flow engineering diagram showing a mutation pipeline with numbered stages.

TOP: Bold hand-lettered "3. EMS — ENTITY MODEL SYSTEM" in white with amber double underline. Cyan subtitle: "database abstraction with 10-ring observer pipeline. streaming queries with backpressure."

MAIN AREA — OBSERVER PIPELINE: A large horizontal pipeline diagram dominates the center. A mutation arrow enters from the left labeled "create / update / delete" and passes through 10 numbered ring stages drawn as concentric circles or gate symbols, each with its ring number and purpose:

Ring 0: "DATA PREP" — small merge icon, label "UpdateMerger — deduplication". Ring 1: "VALIDATION" — shield icon, label "Frozen, Immutable, Constraints". Ring 2: "SECURITY" — lock icon. Ring 3: "BUSINESS LOGIC" — gear icon. Ring 4: "ENRICHMENT" — transform arrows, label "TransformProcessor — field transforms". Ring 5: "DATABASE" — cylinder icon, label "SqlCreate, SqlUpdate, SqlDelete, PathnameSync". Ring 6: "POST-DB" — schema icon, label "DdlCreateModel, DdlCreateField". Ring 7: "AUDIT" — checkmark, label "Tracked — change tracking". Ring 8: "INTEGRATION" — cache icon, label "Cache, PathCache invalidation". Ring 9: "NOTIFICATION" — bell icon, label "PubsubNotify".

The rings are connected by a flow arrow passing through each sequentially. The pipeline widens slightly at Ring 5 (database) to show it as the critical persistence stage. After Ring 9, the arrow exits right labeled "committed + notified".

UPPER LEFT: A pinned amber card titled "ARCHITECTURE" showing the EMS layer stack: "EntityOps (streaming CRUD)" on top, "Observer Pipeline (10 rings)" middle, "DatabaseOps (generic SQL)" below, "DatabaseConnection (HAL channel)" below that, "HAL ChannelDevice (SQLite/PostgreSQL)" at bottom. Thin arrows connect each layer downward.

UPPER RIGHT: A pinned card titled "STORAGE KEYS" showing the key-value schema: "entity:{uuid} → JSON metadata", "access:{uuid} → ACL data", "child:{parent}:{name} → child UUID", "data:{uuid} → file content blob". Annotation: "O(1) child lookup by parent+name."

BOTTOM LEFT: A pinned card titled "STREAMING" showing: "all queries return AsyncIterable<Response>. never materialize full result sets. backpressure built in. collect() convenience wrapper for small datasets." The word "AsyncIterable" is underlined.

BOTTOM RIGHT: A pinned card titled "CACHING" showing two boxes: "ModelCache — entity type metadata" and "EntityCache — instance cache by type". Arrow between them labeled "invalidated by Ring 8 observers on every mutation."

Faint cyan margin scribbles: "observers are classes, not hooks — testable independently", "ring order is enforced — validation before persistence", "supports SQLite and PostgreSQL via same interface".

No people, no faces. Dense annotations, leader lines, pushpins, worn blueprint edges, faint grid throughout.
