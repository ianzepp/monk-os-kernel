// Model JSON definition linter
// Validates that default_value matches the declared type

import { Glob } from "bun";

const errors: string[] = [];
const glob = new Glob("rom/app/*/models/*.json");

for await (const path of glob.scan(".")) {
    const data = await Bun.file(path).json();

    for (const [field, def] of Object.entries(data.fields ?? {})) {
        const { type, default_value } = def as { type?: string; default_value?: string };
        if (!default_value) continue;

        if (type === "boolean" && !["true", "false"].includes(default_value)) {
            errors.push(`${path}: ${field} (boolean) has invalid default "${default_value}" - use "true"/"false"`);
        }

        if ((type === "integer" || type === "numeric") && !/^-?\d+(\.\d+)?$/.test(default_value)) {
            errors.push(`${path}: ${field} (${type}) has invalid default "${default_value}" - use numeric string`);
        }
    }
}

if (errors.length) {
    console.error("Model definition errors:\n" + errors.join("\n"));
    process.exit(1);
}
console.log("All model definitions valid");
