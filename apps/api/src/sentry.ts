import * as Sentry from '@sentry/node';

let sentryEnabled = false;

export function initializeSentry(dsn: string | undefined): void {
  if (!dsn) return;
  sentryEnabled = true;
  Sentry.init({
    dsn,
    beforeSend(event) {
      // Exception messages, request data, and breadcrumbs can contain agent-supplied values.
      event.request = undefined;
      event.extra = undefined;
      event.user = undefined;
      event.breadcrumbs = [];
      for (const exception of event.exception?.values ?? []) exception.value = 'Application error';
      if (event.message) event.message = 'Application error';
      return event;
    },
    beforeSendTransaction(event) {
      event.request = undefined;
      event.extra = undefined;
      event.user = undefined;
      event.breadcrumbs = [];
      event.transaction = 'API transaction';
      for (const span of event.spans ?? []) {
        span.description = undefined;
        span.data = {};
      }
      return event;
    },
    beforeSendSpan(span) {
      return { ...span, name: 'API operation', description: undefined, data: {}, attributes: {} };
    },
    beforeBreadcrumb(breadcrumb) {
      return ['http', 'fetch', 'console'].includes(breadcrumb.category ?? '') ? null : breadcrumb;
    },
  });
}

export function reportException(error: unknown): void {
  if (sentryEnabled) Sentry.captureException(error);
}
