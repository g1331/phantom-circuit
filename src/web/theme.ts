import { useEffect, useState } from 'react';

export function useTheme() {
  const [preference, setPreference] = useState(() => {
    const saved = localStorage.getItem('phantom.theme');
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  });
  const [systemDark, setSystemDark] = useState(
    () => matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    localStorage.setItem('phantom.theme', preference);
  }, [resolved, preference]);
  return { preference, setPreference, resolved };
}
