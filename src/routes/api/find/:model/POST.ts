import { withTransaction } from '@src/lib/api-helpers.js';

export default withTransaction(async ({ system, params, body }) => {
    const { model } = params;

    console.debug('routes/find-model: model=%j', model);

    // Support trashed option in body (not URL query param)
    const trashed = body?.trashed;
    const options = trashed ? { trashed } : {};
    const result = await system.database.selectAny(model!, body, options);

    // If count=true or includeTotal=true, include total filtered count for pagination
    if (body?.count === true || body?.includeTotal === true) {
        const total = await system.database.count(model!, body);
        return { data: result, total };
    }

    return result;
});
