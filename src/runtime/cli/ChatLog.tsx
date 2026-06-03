import React from 'react';
import { Box, Text } from 'ink';
import type { ChatEntry, ChatSegment } from './cli-store.js';
import { parseInlineMarkdown, type MdSegment } from '../../util/markdown.js';

const Segment: React.FC<{ s: ChatSegment }> = ({ s }) => (
  <Text
    {...(s.color !== undefined && { color: s.color })}
    {...(s.bold !== undefined && { bold: s.bold })}
    {...(s.dim !== undefined && { dimColor: s.dim })}
  >{s.text}</Text>
);

const Markdown: React.FC<{ text: string; dim?: boolean }> = ({ text, dim }) => {
  const segs = parseInlineMarkdown(text);
  return (
    <>
      {segs.map((seg, i) => (
        <MdRun key={i} seg={seg} {...(dim !== undefined && { dim })} />
      ))}
    </>
  );
};

const MdRun: React.FC<{ seg: MdSegment; dim?: boolean }> = ({ seg, dim }) => {
  const props: Record<string, unknown> = {};
  if (seg.bold) props['bold'] = true;
  if (seg.italic) props['italic'] = true;
  if (seg.strike) props['strikethrough'] = true;
  // Code is rendered cyan to stand out in a terminal — Ink has no monospace
  // switch, since the terminal is already monospaced.
  if (seg.code) props['color'] = 'cyan';
  if (dim) props['dimColor'] = true;
  return <Text {...props}>{seg.text}</Text>;
};

export const ChatLog: React.FC<{ entries: ChatEntry[] }> = ({ entries }) => (
  <Box flexDirection="column" marginTop={1}>
    {entries.slice(-12).map((e) => {
      // dim resolution lines so dialogue and narration stand out
      const dim = e.kind === 'resolution';
      // Narrate / say / human-input (kind === 'say' covers all dialogue
      // entries including the human player's free-text input — see
      // cli-store.ingest) are markdown-rendered so **bold** / *italic* /
      // `code` come through in the terminal.
      const isDialog = e.kind === 'narrate' || e.kind === 'say';
      return (
        <Box key={e.t} flexDirection="row">
          <Text>{e.emoji} </Text>
          <Text color={e.color} bold>{e.who}: </Text>
          {e.segments
            ? e.segments.map((s, i) => <Segment key={i} s={s} />)
            : isDialog
              ? <Markdown text={e.text} />
              : <Text dimColor={dim}>{e.text}</Text>}
        </Box>
      );
    })}
  </Box>
);
