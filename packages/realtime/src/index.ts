/**
 * `@scani/realtime`
 *
 * WS transport + Redis pub/sub for realtime entity-change events. The
 * backend owns the WebSocket endpoint; workers + cron publish to the
 * same `rt:user:<userId>` channel that backend subscribes to, so job
 * progress and entity changes stream through the same fan-out.
 */

export * from './RealTimeUpdatesService';
