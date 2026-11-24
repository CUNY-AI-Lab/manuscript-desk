// The one model every call of Manuscript Desk uses. The pages never offer a choice: they send no
// model, and the Worker uses this one whatever a request says. The measurement scripts may name
// another for a run of their own (they call the Gateway with their own key, or start the local dev
// server with MANUSCRIPT_DESK_MODEL); the deployed Worker never does. Pure data.

export const MODEL = 'deepseek-v4.1-flash-1017';

// What the pages say when the Gateway's catalog no longer lists the model.
export const UNAVAILABLE = 'The tool is unavailable for now: the model it uses is not offered by the CUNY AI Lab service at the moment. Please try again later.';
