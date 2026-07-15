import { useEffect, useState } from 'react';

export interface TerminalSize {
  columns: number;
  rows: number;
}

function current(): TerminalSize {
  // `||` not `??`: a pty with no size (e.g. under `script`) reports 0 columns
  return { columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>(current);
  useEffect(() => {
    const onResize = () => setSize(current());
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
  return size;
}
