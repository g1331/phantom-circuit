import { HostRequestError } from './api.ts';
import { useLocale } from './locale/provider.tsx';

export function ErrorText({ error }: { error: string | Error }) {
  const { host } = useLocale();
  if (error instanceof HostRequestError) {
    const message = host(error.message, error.descriptor);
    return (
      <>
        {message}
        {message !== error.message && (
          <small className="request-error-detail">{error.descriptor.detail ?? error.message}</small>
        )}
      </>
    );
  }
  return error instanceof Error ? error.message : error;
}
