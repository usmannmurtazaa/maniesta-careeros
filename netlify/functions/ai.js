// ─────────────────────────────────────────────────────────────────────────────
// Maniesta CareerOS — Gemini AI Proxy (C-04)
//
// This serverless function is the ONLY way the client can reach Gemini.
// It performs, in order:
//
//   1. Method check (POST only).
//   2. Firebase ID token verification via the Firebase Admin SDK.
//   3. Server configuration check (GEMINI_API_KEY, GEMINI_MODEL).
//   4. Request body parse and payload validation.
//   5. Per-user daily rate limit check (Firestore counter).
//   6. Server-side prompt construction per task.
//   7. Gemini REST call with an AbortController timeout.
//   8. Response parsing and sanitization.
//   9. Atomic counter increment on success.
//  10. Normalized JSON response.
//
// Hard constraints from the C-04 spec:
//   • The Gemini API key is read from `process.env` inside this function
//     only. It is never sent to the client, never logged, and never
//     included in any error response.
//   • The client cannot control the model, the system prompt, the
//     temperature, the max output tokens, or any other model parameter.
//   • The authenticated UID is derived exclusively from the verified
//     Firebase ID token. Client-supplied UID, role, plan, or admin flags
//     are ignored.
//   • Firebase Spark plan is a hard constraint: no Cloud Functions, no
//     Blaze, no paid Firebase services.
//   • No realtime listeners are created by this function.
//
// Firestore usage (Option A2):
//   • First call of the day, per user: 3 reads + 1 write.
//       - read `users/{uid}/aiUsage/{YYYY-MM-DD}` (may not exist yet)
//       - read `users/{uid}` and `subscriptions/{uid}` in parallel to
//         determine the plan, because no plan is cached for today yet
//       - write the counter with `{ count: 1, plan, lastCallAt }`
//   • Subsequent calls the same day: 1 read + 1 write.
//       - read the counter (plan is cached in the doc)
//       - write `{ count: increment(1), lastCallAt }`
//
//   Failed Gemini calls do NOT increment the counter, so a user is not
//   charged for calls that produced no output.
//
// Rate limiting is application-level only. The limits configured via
// AI_FREE_DAILY_LIMIT / AI_PREMIUM_DAILY_LIMIT are NOT claims about
// Google's Gemini limits. Google's actual limits are enforced by Google
// when the function exceeds them, in which case the function returns an
// upstream error and the client falls back to its local generators.
//
// Note on the Gemini REST format:
//   The endpoint, header name, request body shape, and response body
//   shape used below match the Gemini API as documented at the time this
//   file was written. If the API changes, update the constants in the
//   "Gemini REST configuration" section below. The endpoint, header, and
//   shapes are the only parts of this file that depend on the Gemini
//   API version.
// ─────────────────────────────────────────────────────────────────────────────

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const db = admin.firestore();

// ── Configuration ───────────────────────────────────────────────────────────

const GEMINI_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Safely parses an integer environment variable.
 *
 * `Number.parseInt` returns `NaN` for any non-numeric input — including
 * the empty string, `"10x"`, `"  "`, or a value with thousands separators.
 * A `NaN` propagates silently:
 *   • A `NaN` daily limit makes every `count >= limit` comparison return
 *     `false`, which disables the rate limit entirely.
 *   • A `NaN` timeout schedules `setTimeout(fn, NaN)` which fires on the
 *     next tick, aborting every Gemini call immediately.
 *
 * This helper rejects `undefined`, `null`, empty strings, unparsable
 * strings, `NaN`, infinities, and values below `min`, falling back to the
 * caller-supplied default. A malformed environment variable therefore
 * degrades to a safe value instead of silently disabling a protection.
 */
const parseIntEnv = (raw, fallback, min = 0) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
};

// Application-level daily limits. These are NOT Google's limits.
// A `min` of 0 is allowed: setting the limit to 0 is a legitimate way to
// disable AI for that plan tier.
const AI_FREE_DAILY_LIMIT = parseIntEnv(process.env.AI_FREE_DAILY_LIMIT, 10, 0);
const AI_PREMIUM_DAILY_LIMIT = parseIntEnv(process.env.AI_PREMIUM_DAILY_LIMIT, 100, 0);

// Server-side timeout for the upstream Gemini call.
//
// The default is deliberately 8000 ms — well under Netlify's 10 s
// synchronous function timeout. When the function's own timeout fires,
// the handler returns a graceful `504 { success: false, error: "AI
// service timed out." }` JSON body. The client then falls back to its
// local generator with an informative message.
//
// If the function waits longer than Netlify's platform limit (previous
// default was 20 000 ms), the platform kills the container before the
// function's own timeout can fire. The client receives a bare 504 with
// no JSON body and no error message, and cannot distinguish "AI timed
// out gracefully" from "the whole function crashed". That is the exact
// symptom that motivated lowering this default.
//
// `GEMINI_TIMEOUT_MS` may still be set as an environment variable to
// override this default per environment. `min` is 1000 ms: a sub-second
// timeout would abort every call and is never intentional.
const GEMINI_TIMEOUT_MS = parseIntEnv(process.env.GEMINI_TIMEOUT_MS, 8000, 1000);

// Payload caps. These bound what a client can put on the wire and, more
// importantly, what can end up in a Gemini prompt.
const MAX_INPUT_SERIALIZED_LENGTH = 4000;
const MAX_STRING_FIELD_LENGTH = 500;
const MAX_ARRAY_ITEMS = 20;
const MAX_ARRAY_ITEM_LENGTH = 100;

// Output caps applied to the model's response before it is returned.
const MAX_OUTPUT_LENGTH = 2000;

// ── Task registry ───────────────────────────────────────────────────────────
//
// Each task maps to a server-side prompt builder. The client sends a task
// identifier and an `input` object; it never sends a prompt.
//
// Every prompt follows the same house rules:
//   • ATS-friendly, professional, concise.
//   • Factual: do not invent experience, education, certifications,
//     achievements, metrics, users, or technologies not present in the
//     input.
//   • Return only the requested content, with no commentary, headings,
//     quotes, or code fences.
//
// If a new task is added, add an entry here. The client's `task` field is
// validated against this map, so unknown tasks are rejected automatically.

const TASKS = {
  improve_summary: (input) => `
You are a professional resume editor. Improve the following resume
professional summary. Keep it ATS-friendly, concise (2–4 sentences),
professional, and factual. Use first-person-implied voice.

Do not invent qualifications, experience, education, certifications, or
achievements that are not present in the original.

Return only the improved summary text, with no quotes, headings,
explanations, or code fences.

Original summary:
${input.text || '(empty — write a concise professional summary from this title: ' + (input.title || 'professional') + ')'}
  `.trim(),

  generate_summary: (input) => `
You are a professional resume editor. Write a resume professional summary
for the following person. Keep it ATS-friendly, concise (2–4 sentences),
professional, and factual. Use first-person-implied voice.

Do not invent qualifications, experience, education, certifications, or
achievements that are not provided below.

Return only the summary text, with no quotes, headings, explanations, or
code fences.

Name: ${input.fullName || '(not provided)'}
Title: ${input.title || '(not provided)'}
Industry: ${input.industry || '(not provided)'}
  `.trim(),

  improve_experience: (input) => `
You are a professional resume editor. Improve the following resume
experience description. Keep it ATS-friendly, professional, and factual.
Use strong action verbs. Quantify impact only where the original implies
it — do not invent metrics.

Return only the improved description, formatted as 3–5 bullet points, one
per line, with no leading numbers or dashes and no extra commentary.

Original description:
${input.text || '(empty)'}
  `.trim(),

  generate_experience: (input) => `
You are a professional resume editor. Write 3–5 resume bullet points for
the following role. Keep them ATS-friendly, professional, and factual.
Start each bullet with a strong action verb. Do not invent metrics,
achievements, or responsibilities that are not implied by the context
below.

Return only the bullet points, one per line, with no leading numbers,
dashes, or commentary.

Role: ${input.role || '(not provided)'}
Company: ${input.company || '(not provided)'}
Context: ${input.context || '(not provided)'}
  `.trim(),

  improve_project: (input) => `
You are a professional resume editor. Improve the following resume
project description. Keep it professional, concise (2–4 sentences), and
factual. Do not invent features, technologies, users, or metrics that are
not present in the original.

Return only the improved description, with no quotes, headings,
explanations, or code fences.

Original description:
${input.text || '(empty)'}
  `.trim(),

  generate_project: (input) => `
You are a professional resume editor. Write a professional resume project
description for the following project. Keep it concise (2–4 sentences)
and factual. Do not invent features, users, or metrics that are not
implied by the input below.

Return only the description, with no quotes, headings, explanations, or
code fences.

Project name: ${input.name || '(not provided)'}
Technologies: ${Array.isArray(input.technologies) ? input.technologies.join(', ') : '(not provided)'}
  `.trim(),

  generate_skills: (input) => `
You are a professional resume editor. List 8–12 relevant professional
skills for the role below. Prefer industry-standard skill names.

Return only the skill names, comma-separated, with no commentary,
numbering, bullets, or headings. Do not invent certifications.

Role: ${input.title || '(not provided)'}
Industry: ${input.industry || '(not provided)'}
  `.trim(),

  improve_bullet: (input) => `
You are a professional resume editor. Improve the following single resume
bullet point. Keep it ATS-friendly, professional, and factual. Start with
a strong action verb. Do not invent metrics, achievements, or
responsibilities.

Return only the improved bullet text, with no leading dash or number and
no extra commentary.

Original bullet:
${input.text || '(empty)'}
  `.trim(),
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns today's date as a UTC `YYYY-MM-DD` string. Used as the doc ID
 * for the daily counter so that the counter naturally resets each day —
 * no cron job, no reset logic, no `date` field comparison needed. Old
 * counters are simply left in place; they are ~100 bytes each.
 */
const getTodayUtcString = () => new Date().toISOString().slice(0, 10);

/**
 * Extracts the caller's UID from the `Authorization` header. Returns
 * `null` if the header is missing or malformed. Does NOT verify the token
 * — that is done separately by `verifyAuthToken`.
 */
const extractBearerToken = (authHeader) => {
  if (typeof authHeader !== 'string') return null;
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
};

/**
 * Sanitizes the model's text output before returning it to the client:
 *   • Strips leading and trailing triple-backtick fences (some models wrap
 *     output in markdown even when instructed not to).
 *   • Trims surrounding whitespace.
 *   • Caps the total length.
 * Returns an empty string if the input is not a non-empty string.
 */
const sanitizeModelText = (raw) => {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();
  // Strip a single leading and/or trailing code fence. The regex is
  // intentionally narrow: it only removes ``` at the very start followed
  // by an optional language tag and a newline, and ``` at the very end.
  text = text.replace(/^```[a-zA-Z0-9]*\s*\n?/, '');
  text = text.replace(/\n?```\s*$/, '');
  text = text.trim();
  if (text.length > MAX_OUTPUT_LENGTH) {
    text = text.slice(0, MAX_OUTPUT_LENGTH).trim();
  }
  return text;
};

/**
 * Validates and normalizes the client's `input` payload. Returns a
 * sanitized object or `null` if the input is invalid.
 *
 * Rules:
 *   • Must be a plain object (not null, not an array).
 *   • Serialized form must be ≤ MAX_INPUT_SERIALIZED_LENGTH.
 *   • String fields are truncated to MAX_STRING_FIELD_LENGTH.
 *   • Array fields keep at most MAX_ARRAY_ITEMS strings, each truncated to
 *     MAX_ARRAY_ITEM_LENGTH.
 *   • Any field that is neither a string nor an array-of-strings is
 *     discarded. This prevents a client from smuggling an object into a
 *     prompt via a nested structure.
 */
const validateInput = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  let serialized;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return null;
  }
  if (serialized.length > MAX_INPUT_SERIALIZED_LENGTH) return null;

  const sanitized = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      sanitized[key] = value.slice(0, MAX_STRING_FIELD_LENGTH);
    } else if (Array.isArray(value)) {
      sanitized[key] = value
        .slice(0, MAX_ARRAY_ITEMS)
        .filter((item) => typeof item === 'string')
        .map((item) => item.slice(0, MAX_ARRAY_ITEM_LENGTH));
    }
    // Non-string, non-array values are intentionally dropped.
  }
  return sanitized;
};

/**
 * Reads the caller's plan from Firestore.
 *
 * Returns 'premium' for users whose `users/{uid}.role` is 'premium' or
 * 'admin', or whose `subscriptions/{uid}` shows an active premium
 * subscription. Returns 'free' otherwise. Returns 'free' on any Firestore
 * error so that a transient read failure does not accidentally elevate a
 * user's limit.
 *
 * This helper is called at most once per user per day (see the caller in
 * `handler`), because the result is cached in the daily counter document.
 */
const determinePlan = async (uid) => {
  try {
    const [userSnap, subSnap] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('subscriptions').doc(uid).get(),
    ]);

    const userRole = userSnap.exists ? userSnap.data()?.role : null;
    if (userRole === 'admin' || userRole === 'premium') return 'premium';

    if (subSnap.exists) {
      const sub = subSnap.data();
      if (sub?.status === 'active' && sub?.plan === 'premium') return 'premium';
    }

    return 'free';
  } catch (error) {
    // Fail safe: a Firestore read failure should never elevate a user's
    // limit. Log only the error code — not the UID — and treat the user
    // as free.
    console.error('determinePlan failed:', {
      code: error?.code,
      message: String(error?.message || '').slice(0, 200),
    });
    return 'free';
  }
};

/**
 * Reads the caller's daily counter and, if the plan is not already cached
 * in it, determines the plan and returns it. Does NOT write — the caller
 * writes only on successful Gemini output.
 *
 * Return shape: { count, plan, ref }
 *   • `count` is the number of successful AI calls already recorded for
 *     the caller today (0 if the counter doc does not exist).
 *   • `plan` is 'free' or 'premium'.
 *   • `ref` is the Firestore document reference, reused by the caller for
 *     the atomic increment.
 */
const getRateLimitState = async (uid, today) => {
  const ref = db.collection('users').doc(uid).collection('aiUsage').doc(today);
  const snap = await ref.get();

  if (snap.exists) {
    const data = snap.data() || {};
    const count = Number.isFinite(data.count) ? data.count : 0;
    const cachedPlan = data.plan === 'premium' || data.plan === 'free' ? data.plan : null;

    if (cachedPlan) {
      return { count, plan: cachedPlan, ref };
    }

    // Counter exists but the plan is not cached (unusual — a schema
    // change or a manual edit). Fall through to determinePlan.
    const plan = await determinePlan(uid);
    return { count, plan, ref };
  }

  // No counter for today. First call of the day for this user.
  const plan = await determinePlan(uid);
  return { count: 0, plan, ref };
};

/**
 * Calls the Gemini REST API. Returns the sanitized text output on success
 * or throws an Error with a `code` property on failure.
 *
 * Error codes used by the caller to choose the HTTP status:
 *   • 'timeout'  — the AbortController fired.
 *   • 'upstream' — any non-2xx response, malformed body, empty content,
 *                  or a finish reason other than STOP.
 */
const callGemini = async ({ apiKey, model, prompt, timeoutMs }) => {
  const url = `${GEMINI_ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The API key is sent as a header rather than a query parameter
        // so it does not end up in URLs, access logs, or stack traces.
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 400,
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('Gemini request timed out');
      timeoutError.code = 'timeout';
      throw timeoutError;
    }
    // Network failure. Do not log the full error — it may contain the
    // request URL and body. Log only the code and a bounded message.
    console.error('Gemini fetch failed:', {
      code: error?.code,
      message: String(error?.message || '').slice(0, 200),
    });
    const networkError = new Error('Gemini request failed');
    networkError.code = 'upstream';
    throw networkError;
  }
  clearTimeout(timer);

  if (!response.ok) {
    // Read and discard the body — it may contain internal detail. Log
    // only the status code and a bounded slice of the body for diagnosis.
    let bodyPreview = '';
    try {
      const text = await response.text();
      bodyPreview = text.slice(0, 200);
    } catch {
      // ignore
    }
    console.error('Gemini non-2xx response:', { status: response.status, bodyPreview });
    const upstreamError = new Error('Gemini request failed');
    upstreamError.code = 'upstream';
    upstreamError.status = response.status;
    throw upstreamError;
  }

  let data;
  try {
    data = await response.json();
  } catch {
    const parseError = new Error('Gemini response was not valid JSON');
    parseError.code = 'upstream';
    throw parseError;
  }

  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const rawText = candidate?.content?.parts?.[0]?.text;

  // Treat non-STOP finish reasons as failures. Returning partial text
  // after a safety block or a length cap would surface content the model
  // did not stand behind or that was truncated mid-sentence.
  if (finishReason && finishReason !== 'STOP') {
    const reasonError = new Error(`Gemini finish reason: ${finishReason}`);
    reasonError.code = 'upstream';
    reasonError.finishReason = finishReason;
    throw reasonError;
  }

  const text = sanitizeModelText(rawText);
  if (!text) {
    const emptyError = new Error('Gemini returned an empty response');
    emptyError.code = 'upstream';
    throw emptyError;
  }

  return text;
};

// ── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // ── 1. Method check ──────────────────────────────────────────────────────
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ success: false, error: 'Method Not Allowed' }),
    };
  }

  // ── 2. Configuration check ───────────────────────────────────────────────
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL;

  if (!apiKey || !model) {
    // Log a single line so an operator can see exactly which variable is
    // missing, without echoing any value.
    console.error('Gemini function misconfigured:', {
      hasApiKey: Boolean(apiKey),
      hasModel: Boolean(model),
    });
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: 'AI service is not configured.',
      }),
    };
  }

  // ── 3. Authentication ────────────────────────────────────────────────────
  const token = extractBearerToken(event.headers.authorization);
  if (!token) {
    return {
      statusCode: 401,
      body: JSON.stringify({ success: false, error: 'Authentication required.' }),
    };
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (error) {
    // Do not echo the Admin SDK error. Log only a code and a short
    // message — the UID is not logged.
    console.error('AI auth verification failed:', {
      code: error?.code,
      message: String(error?.message || '').slice(0, 200),
    });
    return {
      statusCode: 401,
      body: JSON.stringify({ success: false, error: 'Authentication required.' }),
    };
  }

  const uid = decoded.uid;

  // ── 4. Parse request body ────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: false, error: 'Invalid request body.' }),
    };
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: false, error: 'Invalid request body.' }),
    };
  }

  const { task: taskName, input: rawInput } = body;

  // ── 5. Validate task ─────────────────────────────────────────────────────
  if (typeof taskName !== 'string' || !TASKS[taskName]) {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: false, error: 'Unsupported task.' }),
    };
  }

  const taskBuilder = TASKS[taskName];

  // ── 6. Validate input ────────────────────────────────────────────────────
  const input = validateInput(rawInput);
  if (!input) {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: false, error: 'Invalid input.' }),
    };
  }

  // ── 7. Rate limit check ──────────────────────────────────────────────────
  let rateState;
  try {
    const today = getTodayUtcString();
    rateState = await getRateLimitState(uid, today);
  } catch (error) {
    // Fail closed: if we cannot read the counter, deny the request rather
    // than risk exhausting the free Gemini quota during a Firestore
    // incident. Log only the error code and a bounded message.
    console.error('AI rate limit read failed:', {
      code: error?.code,
      message: String(error?.message || '').slice(0, 200),
    });
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: 'AI service is temporarily unavailable.',
      }),
    };
  }

  const limit = rateState.plan === 'premium' ? AI_PREMIUM_DAILY_LIMIT : AI_FREE_DAILY_LIMIT;

  if (rateState.count >= limit) {
    return {
      statusCode: 429,
      body: JSON.stringify({
        success: false,
        error: 'Daily AI limit reached. Please try again tomorrow.',
      }),
    };
  }

  // ── 8. Build the prompt ──────────────────────────────────────────────────
  let prompt;
  try {
    prompt = taskBuilder(input);
  } catch (error) {
    console.error('AI prompt build failed:', {
      task: taskName,
      message: String(error?.message || '').slice(0, 200),
    });
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: 'AI service is temporarily unavailable.',
      }),
    };
  }

  // ── 9. Call Gemini ───────────────────────────────────────────────────────
  let text;
  try {
    text = await callGemini({ apiKey, model, prompt, timeoutMs: GEMINI_TIMEOUT_MS });
  } catch (error) {
    const isTimeout = error?.code === 'timeout';
    return {
      statusCode: isTimeout ? 504 : 502,
      body: JSON.stringify({
        success: false,
        error: isTimeout
          ? 'AI service timed out. Please try again.'
          : 'AI service is temporarily unavailable.',
      }),
    };
  }

  // ── 10. Increment the counter on success ────────────────────────────────
  //
  // The increment happens only after Gemini returned usable text. A failed
  // call does not consume the caller's daily quota. The write uses
  // `merge: true` and an atomic `increment(1)` so concurrent requests from
  // the same user cannot lose updates.
  //
  // The `plan` field is (re)written here too, so that the first successful
  // call of the day caches the plan alongside the count, and subsequent
  // calls can skip the user/subscription reads in `getRateLimitState`.
  //
  // A failure to write the counter does not fail the response — the user
  // already has their text. The write failure is logged so drift is
  // visible.
  try {
    await rateState.ref.set(
      {
        count: admin.firestore.FieldValue.increment(1),
        plan: rateState.plan,
        lastCallAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    console.error('AI counter increment failed:', {
      code: error?.code,
      message: String(error?.message || '').slice(0, 200),
    });
  }

  // ── 11. Return the sanitized result ──────────────────────────────────────
  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      text,
    }),
  };
};