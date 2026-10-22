/**
 * The event stream a shape's reply arrives in.
 *
 * Every shape streams its reply as a sequence of events, each carrying a name
 * and a payload. This reader turns the bytes of that stream into the events,
 * and it holds only the **current, incomplete** event — never the whole
 * reply.
 */

/** One streamed event. */
export interface SseEvent {
  /** The event's name, when it carries one. */
  readonly event?: string;
  /** The event's payload. */
  readonly data: string;
}

/** A reader over a streamed reply. */
export interface SseReader {
  /** Feed a piece of the reply; the events it completes are returned. */
  push(chunk: string): readonly SseEvent[];
  /** The reply is over; the event it completes is returned. */
  end(): readonly SseEvent[];
}

/**
 * A reader over a streamed reply.
 *
 * The buffer holds the **current, incomplete** event only: a line is read,
 * its members are collected, and the event is emitted when the blank line
 * that ends it arrives.
 */
export function createSseReader(): SseReader {
  let buffer = '';
  let eventName: string | undefined;
  let data: string[] = [];

  function take(): SseEvent[] {
    if (data.length === 0 && eventName === undefined) return [];
    const payload = data.join('\n');
    const name = eventName;
    eventName = undefined;
    data = [];
    if (payload === '' && name === undefined) return [];
    return name === undefined ? [{ data: payload }] : [{ event: name, data: payload }];
  }

  return {
    push(chunk: string): readonly SseEvent[] {
      buffer += chunk;
      const events: SseEvent[] = [];
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line === '') {
          events.push(...take());
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const raw = colon === -1 ? '' : line.slice(colon + 1);
        const value = raw.startsWith(' ') ? raw.slice(1) : raw;
        if (field === 'event') eventName = value;
        else if (field === 'data') data.push(value);
      }
      return events;
    },
    end(): readonly SseEvent[] {
      const rest = buffer.trim();
      buffer = '';
      if (rest !== '') {
        // A last line without its terminating newline is still a line.
        const colon = rest.indexOf(':');
        const field = colon === -1 ? rest : rest.slice(0, colon);
        const raw = colon === -1 ? '' : rest.slice(colon + 1);
        const value = raw.startsWith(' ') ? raw.slice(1) : raw;
        if (field === 'event') eventName = value;
        else if (field === 'data') data.push(value);
      }
      return take();
    },
  };
}
