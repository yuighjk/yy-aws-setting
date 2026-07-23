export const handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records ?? []) {
    try {
      const message = JSON.parse(record.body);
      if (message.simulateFailure === true) {
        throw new Error("simulated consumer failure");
      }
      if (message.eventType !== "NoteCreated" || !message.eventId || !message.noteId) {
        throw new Error("invalid NoteCreated event contract");
      }

      // A real consumer could send a notification or persist an audit record.
      // The homework consumer logs the durable event so retry and DLQ behavior
      // remain observable without creating another database or external service.
      console.log("note event processed", {
        environment: message.environment,
        eventId: message.eventId,
        noteId: message.noteId,
      });
    } catch (error) {
      console.error("note event failed", {
        error: error instanceof Error ? error.message : "unknown error",
        messageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
