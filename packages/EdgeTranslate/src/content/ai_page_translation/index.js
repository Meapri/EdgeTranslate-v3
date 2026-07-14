/**
 * Public surface of the vNext AI page translation engine (spec §8 module map).
 *
 * `createAiPageTranslationSession(options)` gates the cloud engines
 * (googleAiStudio | openai | openaiCompatible — chromeBuiltin stays on the V1 bridge) and
 * returns a controller with start / stop / getStatusSnapshot. The controller also owns the
 * auth session circuit (spec §7): after two session attempts that die on an
 * auth-class provider circuit, further starts are refused without issuing a single
 * request.
 *
 * The scheduler and priority-queue factories are injectable through `options.deps` (tests
 * and callers that already hold them); when absent they are loaded from the sibling
 * runtime modules at first start.
 */

import { createPriorityQueue } from "./runtime/priority_queue.js";
import { TERMINAL_FAILURE_KINDS } from "./runtime/recovery.js";
import { createScheduler } from "./runtime/scheduler.js";
import { AiPageTranslationSession } from "./runtime/session.js";

const SUPPORTED_ENGINES = Object.freeze(["googleAiStudio", "openai", "openaiCompatible"]);
const MAX_AUTH_SESSION_ATTEMPTS = 2;

function isAuthClassFailure(failure) {
    return Boolean(failure && TERMINAL_FAILURE_KINDS.has(failure.kind));
}

function resolveRuntimeDeps(deps = {}) {
    // Content scripts execute in the host page's isolated world. A Webpack `import()` chunk
    // resolves against the page origin unless the extension runtime public path is installed
    // first, which made production builds request e.g. https://site.example/764.js. Keep these
    // small factories in the content bundle so session startup has no network/chunk dependency.
    return {
        ...deps,
        createScheduler: deps.createScheduler || createScheduler,
        createPriorityQueue: deps.createPriorityQueue || createPriorityQueue,
    };
}

function createAiPageTranslationSession(options = {}) {
    const engine = String(options.engine || "");
    if (!SUPPORTED_ENGINES.includes(engine)) {
        throw new Error(
            `AI page translation vNext supports engines ${SUPPORTED_ENGINES.join(", ")}; got "${
                engine || "none"
            }"`
        );
    }

    let session = null;
    let authFailures = 0;
    let refusedSnapshot = null;

    const onStatus = (snapshot) => {
        if (typeof options.onStatus === "function") options.onStatus(snapshot);
    };

    return {
        get sessionId() {
            return session?.sessionId || null;
        },

        async start() {
            if (session && !session.finalized) return session.getStatusSnapshot();
            if (authFailures >= MAX_AUTH_SESSION_ATTEMPTS) {
                // Auth circuit (spec §7): ≤2 session attempts, then fail loud with zero
                // additional provider requests.
                refusedSnapshot = {
                    ...(session ? session.getStatusSnapshot() : {}),
                    phase: "error",
                    failure: { kind: "auth-circuit", attempts: authFailures },
                };
                onStatus(refusedSnapshot);
                return refusedSnapshot;
            }
            const deps = await resolveRuntimeDeps(options.deps);
            session = new AiPageTranslationSession({
                ...options,
                deps,
                onStatus: (snapshot) => {
                    if (snapshot.phase === "error" && isAuthClassFailure(snapshot.failure)) {
                        if (!session?._authCounted) {
                            if (session) session._authCounted = true;
                            authFailures += 1;
                        }
                    }
                    onStatus(snapshot);
                },
            });
            return session.start();
        },

        stop(reason) {
            return session ? session.stop(reason) : null;
        },

        getStatusSnapshot() {
            if (session) return session.getStatusSnapshot();
            return refusedSnapshot || { phase: "idle" };
        },
    };
}

export { MAX_AUTH_SESSION_ATTEMPTS, SUPPORTED_ENGINES, createAiPageTranslationSession };
