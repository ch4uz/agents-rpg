import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface InputLineProps {
  enabled: boolean;
  onSubmit(line: string): void;
}

export const InputLine: React.FC<InputLineProps> = ({ enabled, onSubmit }) => {
  const [buf, setBuf] = useState('');

  useInput((input, key) => {
    if (!enabled) return;
    if (key.return) {
      const submitted = buf;
      setBuf('');
      onSubmit(submitted);
      return;
    }
    if (key.backspace || key.delete) {
      setBuf((b) => b.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setBuf((b) => b + input);
    }
  }, { isActive: enabled });

  if (!enabled) return <Text dimColor>Waiting for the active turn…</Text>;
  return (
    <Box>
      <Text>{'> '}</Text>
      <Text>{buf}</Text>
      <Text inverse>{' '}</Text>
    </Box>
  );
};
