# Slide 4: VFS — Virtual File System

## Style Brief

(Same as title slide — deep indigo/navy blueprint, white/cyan line art, amber-gold accents, hand-drafted quality.)

## Layout: Filesystem Tree with Model Architecture

## Prompt

Architectural blueprint on deep indigo-navy paper with faint cyan grid lines, fold creases, and worn edges. White and light cyan chalk-like line work, hand-drafted quality. Amber-gold accents on pinned notes only. 16:9 aspect ratio. The feel of a filesystem architecture diagram — part directory tree, part class hierarchy.

TOP: Bold hand-lettered "4. VFS — VIRTUAL FILE SYSTEM" in white with amber double underline. Cyan subtitle: "everything is a file. everything has a UUID. everything can be queried."

LEFT HALF — DIRECTORY TREE: A large hand-drawn filesystem tree rooted at "/" spreading downward and rightward. Major branches drawn as thick white lines with directory names at each node:

"/" root branches to: "/app" with annotation "application services", "/bin" with "executables", "/dev" with "devices", "/ems" with "entity queries", "/etc" with "configuration", "/home" with "user directories", "/proc" with "process info", "/tmp" with "ephemeral", "/usr" with "packages", "/var" with "runtime data", "/vol" with "mounted volumes".

Under "/dev", child nodes: "console", "random", "null", "zero", "clock", "gzip", "deflate". Under "/proc", child nodes showing UUID-style labels: "{uuid}/stat", "{uuid}/env". These subtrees are drawn with thinner lines suggesting virtual/generated content.

RIGHT HALF — FIVE MODELS: Five large model blocks arranged vertically, each a labeled blueprint module:

"FileModel" — folder icon, annotation "regular files backed by StorageEngine. read, write, seek, truncate." "FolderModel" — tree icon, "directories. children computed via EMS query, not stored." "DeviceModel" — chip icon, "/dev/console, /dev/random, /dev/null, /dev/zero, /dev/clock + compression streams." "ProcModel" — process icon, "/proc/{uuid}/stat, /proc/{uuid}/env — live process info, read-only." "LinkModel" — arrow icon, "symbolic links (currently disabled, throws EPERM)."

Each model block connects leftward with thin traces to its corresponding subtree in the directory tree.

CENTER — HYBRID ARCHITECTURE: A key diagram between tree and models. Two paths diverge from a "VFS resolve path" box. Left path labeled "File, Folder → EMS (SQL tables, EntityCache, observer pipeline)". Right path labeled "Device, Proc, Link → HAL KV storage (virtual, no persistence)". Bold annotation: "path resolution transparently handles both."

BOTTOM LEFT: Pinned amber card titled "DUAL IDENTITY" showing: "as a file: path, contents, open/read/write/close" on the left, "as a database record: UUID, timestamps, custom fields, queryable" on the right. Between them: "same entity, two access patterns."

BOTTOM RIGHT: Pinned card titled "PosixModel INTERFACE" with a small code sketch: "open(), stat(), setstat(), create(), unlink(), list(), watch?()". Annotation: "every model implements this. VFS routes by mount table."

Faint cyan margin scribbles: "UUID via hal.entropy.uuid()", "path = computed from parent_id + name", "permissions: grant-based ACL, not UNIX rwx", "atomic renames via parent_id reassignment".

No people, no faces. Dense annotations, leader lines, pushpins, worn blueprint edges, faint grid throughout.
