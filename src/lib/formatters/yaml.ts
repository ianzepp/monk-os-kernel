/**
 * YAML Formatter
 *
 * YAML format encoding/decoding wrapper.
 */

import { dump as encodeYaml, load as decodeYaml } from 'js-yaml';
import { type Formatter, toBytes, fromBytes } from '@monk/common';

export const YamlFormatter: Formatter = {
    encode(data: any): Uint8Array {
        const yaml = encodeYaml(data, {
            indent: 2,
            lineWidth: 120,
            noRefs: true,
            sortKeys: false,
        });
        return toBytes(yaml);
    },

    decode(data: Uint8Array): any {
        return decodeYaml(fromBytes(data));
    },

    contentType: 'application/yaml; charset=utf-8'
};
