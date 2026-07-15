import {
  EventEnvelopeSchema,
  RuntimeRequestSchema,
  RuntimeResponseSchema,
  type EventEnvelope,
  type RuntimeRequest,
  type RuntimeResponse,
} from "../interface.js";
import type { RuntimeRequestTransport } from "../client.js";

type ScriptedRuntimeResponse =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export interface ScriptedRuntimeTransport extends RuntimeRequestTransport {
  readonly requests: readonly RuntimeRequest[];
  readonly events: () => AsyncIterable<EventEnvelope>;
}

export interface ScriptedRuntimeOptions {
  readonly responses?: readonly ScriptedRuntimeResponse[];
  readonly events?: readonly unknown[];
}

export const createScriptedRuntimeTransport = (
  options: ScriptedRuntimeOptions = {},
): ScriptedRuntimeTransport => {
  const responses = [...(options.responses ?? [])];
  const requests: RuntimeRequest[] = [];

  return {
    requests,
    request: async (input) => {
      const request = RuntimeRequestSchema.parse(input);
      requests.push(request);
      const scripted = responses.shift();
      if (!scripted) {
        throw new Error("Scripted Runtime has no response for this request.");
      }
      return RuntimeResponseSchema.parse({
        id: request.id,
        ...scripted,
      }) as RuntimeResponse;
    },
    events: async function* () {
      for (const event of options.events ?? []) {
        yield EventEnvelopeSchema.parse(event);
      }
    },
  };
};
