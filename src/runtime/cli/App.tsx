import React, { useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { Board } from './Board.js';
import { CharacterPanels } from './CharacterPanels.js';
import { ChatLog } from './ChatLog.js';
import { InputLine } from './InputLine.js';
import type { CliStore, DisplayFor } from './cli-store.js';

interface AppProps {
  store: CliStore;
  displayFor: DisplayFor;
  onSubmit(line: string): void;
}

export const App: React.FC<AppProps> = ({ store, displayFor, onSubmit }) => {
  const snap = useSyncExternalStore(
    (l) => {
      const unsub = store.subscribe(l);
      return () => { unsub(); };
    },
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );

  const turnDisplay = snap.activeActor ? displayFor(snap.activeActor) : null;

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="row">
        <Text>Scene: <Text bold>{snap.scene?.id ?? '—'}</Text>    </Text>
        <Text>Turn: </Text>
        {turnDisplay ? (
          <Text>
            {turnDisplay.emoji} <Text color={turnDisplay.color} bold>{turnDisplay.who}</Text>
          </Text>
        ) : (
          <Text>—</Text>
        )}
        {snap.ended && (
          <Text bold color={snap.ended.outcome === 'success' ? 'green' : 'red'}>
            {'    '}Run ended: {snap.ended.outcome}
          </Text>
        )}
      </Box>
      <Box flexDirection="row" marginTop={1}>
        {snap.grid && <Board grid={snap.grid} characters={snap.characters} props={snap.props} activeActor={snap.activeActor} />}
        <CharacterPanels characters={snap.characters} activeActor={snap.activeActor} />
      </Box>
      <ChatLog entries={snap.chat} />
      <Box marginTop={1}>
        <InputLine enabled={snap.inputUnlocked && !snap.ended} onSubmit={onSubmit} />
      </Box>
    </Box>
  );
};
