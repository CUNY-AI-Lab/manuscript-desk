// Whether the one model the tool uses (lib/calls/model.js) is offered now, from GET
// /manuscript/api/model: true, false, or null when that could not be told (the catalog could not be
// read, or the request failed), in which case the page goes ahead and a call says what is wrong.
// The pages offer no choice of model. No DOM, so it loads under Node.

export async function checkModel(api) {
  try {
    const { available } = await api.get('/api/model');
    return typeof available === 'boolean' ? available : null;
  } catch {
    return null;
  }
}
