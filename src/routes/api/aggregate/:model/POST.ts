import { withTransaction } from '@src/lib/api-helpers.js';

export default withTransaction(async ({ system, params, body }) => {
    const { model } = params;

    console.debug('routes/aggregate-model: model=%j', model);

    // Support trashed option in body for aggregations
    const trashed = body?.trashed;
    const options = trashed ? { trashed } : {};
    const result = await system.database.aggregate(model!, body, options);

    return result;
});
