import { Component, lazy, Suspense, type ComponentProps, type ReactNode } from 'react';
import { ErrorText } from './error-text.tsx';
import { useLocale } from './locale/provider.tsx';

const loadSettings = () => import('./settings-panel.tsx');
const loadTaskDetail = () =>
  import('./task-detail.tsx').then((module) => ({ default: module.TaskDetail }));
let Settings = lazy(loadSettings);
let Detail = lazy(loadTaskDetail);
const resetSettings = () => {
  Settings = lazy(loadSettings);
};
const resetDetail = () => {
  Detail = lazy(loadTaskDetail);
};

function PanelLoading() {
  const { t } = useLocale();
  return (
    <p role="status" aria-live="polite">
      {t('panel.loading')}
    </p>
  );
}

function PanelError({ error, retry }: { error: Error; retry: () => void }) {
  const { t } = useLocale();
  return (
    <div className="inline-warning" role="alert">
      <p>{t('panel.failed')}</p>
      <p>
        <ErrorText error={error} />
      </p>
      <button className="secondary-button" onClick={retry}>
        {t('panel.retry')}
      </button>
    </div>
  );
}

// These two low-frequency panels share only their loading/error presentation. A rejected
// React.lazy promise must be replaced on failure so retry and close/reopen can load again.
class PanelBoundary extends Component<
  {
    renderPanel: () => ReactNode;
    reset: () => void;
  },
  { error?: Error }
> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch() {
    this.props.reset();
  }
  render() {
    if (this.state.error)
      return (
        <PanelError error={this.state.error} retry={() => this.setState({ error: undefined })} />
      );
    return <Suspense fallback={<PanelLoading />}>{this.props.renderPanel()}</Suspense>;
  }
}

export function DeferredSettings(props: ComponentProps<typeof Settings>) {
  return <PanelBoundary reset={resetSettings} renderPanel={() => <Settings {...props} />} />;
}

export function DeferredTaskDetail(props: ComponentProps<typeof Detail>) {
  return <PanelBoundary reset={resetDetail} renderPanel={() => <Detail {...props} />} />;
}
