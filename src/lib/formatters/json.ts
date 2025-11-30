/**
 * JSON Formatter
 *
 * Standard JSON encoding/decoding wrapper.
 */

import { type Formatter, toBytes, fromBytes } from '@monk/common';

export const JsonFormatter: Formatter = {
    encode(data: any): Uint8Array {
        return toBytes(JSON.stringify(data, null, 2));
    },

    decode(data: Uint8Array): any {
        return JSON.parse(fromBytes(data));
    },

    contentType: 'application/json; charset=utf-8'
};
