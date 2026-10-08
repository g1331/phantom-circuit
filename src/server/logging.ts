import { parseArgs } from 'node:util';
import type { FastifyServerOptions, FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { Store } from './store.ts';
import type { Event, PMActivity, Run } from '../shared/types.ts';
import { bounded } from './redaction.ts';

type LoggerOptions = NonNullable<FastifyServerOptions['logger']>;

export function requestRoute(request: FastifyRequest) {
  return request.routeOptions.url ?? '[unmatched]';
}

/** Keep Fastify's internal error logs under the same redaction boundary. */
export function safeLoggerOptions(options: LoggerOptions): LoggerOptions {
  if (options === false) return false;
  return {
    ...(options === true ? {} : options),
    serializers: {
      req: (request: FastifyRequest) => ({ method: request.method, route: requestRoute(request) }),
      res: (reply: { statusCode?: number }) => ({ statusCode: reply.statusCode }),
      err: (error: unknown) =>
        error instanceof Error
          ? {
              type: error.name,
              message: bounded(error.message, 2000),
              stack: bounded(error.stack ?? '', 6000),
            }
          : { type: 'Error', message: bounded(String(error), 2000), stack: '' },
    },
  };
}

export function startupOptions() {
  const { values } = parseArgs({
    options: {
      'pretty-logs': { type: 'boolean', default: false },
      'log-level': { type: 'string' },
      'data-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Phantom Circuit\n\nUsage: npm start -- [--pretty-logs] [--log-level=info] [--data-dir=path]\n\nLog levels: trace, debug, info, warn, error, fatal, silent.\nPHANTOM_LOG_LEVEL sets the default level (info).\n--data-dir selects a separate workspace without adopting checkout-local data.\nUse npm run dev for automatic restart, npm run debug for the Node inspector,\nand npm run dev:web in a second terminal for frontend hot updates.',
    );
    process.exit(0);
  }
  const level = values['log-level'] ?? process.env.PHANTOM_LOG_LEVEL ?? 'info';
  if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(level))
    throw new Error('Invalid log level. Choose trace, debug, info, warn, error, fatal or silent.');
  return {
    dataDir: values['data-dir'],
    logger: {
      level,
      ...(values['pretty-logs']
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: Boolean(process.stdout.isTTY),
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
              },
            },
          }
        : {}),
    },
  };
}

/** Project events stay in SQLite; the terminal receives only operational metadata. */
export function bindRuntimeLogging(store: Store, log: FastifyBaseLogger) {
  const runStarted = (run: Run) =>
    log.info(
      {
        runId: run.id,
        projectId: run.projectId,
        taskId: run.taskId,
        role: run.role,
        agent: run.agentKind,
        status: run.status,
      },
      'run started',
    );
  const runtimeEvent = (event: Event) => {
    // Model replies, task specifications and preview output must remain in their existing UI.
    if (
      ![
        'run',
        'incident',
        'recovery',
        'blocked',
        'checks',
        'sync',
        'engine',
        'pm-trigger',
      ].includes(event.type)
    )
      return;
    const run = event.runId ? store.get('run', event.runId) : undefined;
    const fields = {
      event: event.type,
      eventId: event.id,
      projectId: event.projectId,
      taskId: event.taskId,
      runId: event.runId,
      role: run?.role,
      status: run?.status,
      ...(event.type === 'run' && run?.error ? { err: new Error(run.error) } : {}),
      ...(event.type === 'engine' ? { err: new Error(event.message) } : {}),
    };
    if (run?.status === 'failed' || event.type === 'engine') log.error(fields, 'runtime event');
    else if (['incident', 'blocked'].includes(event.type) || run?.status === 'interrupted')
      log.warn(fields, 'runtime event');
    else log.info(fields, 'runtime event');
  };
  const phase = (activity: PMActivity) => {
    if (activity.kind === 'phase')
      log.debug(
        {
          runId: activity.runId,
          projectId: activity.projectId,
          taskId: activity.taskId,
          activityId: activity.id,
          status: activity.status,
        },
        'run phase',
      );
  };
  store.changes.on('run-start', runStarted);
  store.changes.on('event', runtimeEvent);
  store.changes.on('activity', phase);
  return () => {
    store.changes.off('run-start', runStarted);
    store.changes.off('event', runtimeEvent);
    store.changes.off('activity', phase);
  };
}
