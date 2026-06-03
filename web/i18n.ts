/**
 * Browser UI i18n — a tiny string table + `t()` lookup, no library.
 *
 * The UI language ('en' | 'pt') is a per-BROWSER preference persisted in
 * localStorage (key `agents-rpg-lang`), toggled on the hero-select screen.
 * The same pick ships to the server inside `hero_select_response.language`,
 * which reroutes the agents' LANGUAGE directive — so the DM narrates and the
 * heroes speak the language the UI chrome is rendered in.
 *
 * This module deliberately does NOT import server code (the union is mirrored
 * from `src/runtime/language.ts` — keep the two in sync). Components call
 * `t(key, vars)` inside their lit-html templates, so any re-render after a
 * language switch picks up the new strings automatically; `onLanguageChange`
 * lets the host force one immediate re-render at toggle time.
 */

/** The selectable UI languages, in toggle-display order. Adding a language =
 *  extend this list + LANGUAGE_LABELS + the PT-style message table below
 *  (and mirror the code in src/runtime/language.ts GAME_LANGUAGES). */
export const UI_LANGUAGES = ['en', 'pt'] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];

/** Native-language display label for each language's toggle button. */
export const LANGUAGE_LABELS: Record<UiLanguage, string> = {
  en: 'English',
  pt: 'Português',
};

const STORAGE_KEY = 'agents-rpg-lang';

const isUiLanguage = (v: unknown): v is UiLanguage =>
  typeof v === 'string' && (UI_LANGUAGES as readonly string[]).includes(v);

/** Initial language: the persisted preference, else English. Fully guarded —
 *  storage can throw (privacy modes) and tests run without a DOM. */
const readInitial = (): UiLanguage => {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (isUiLanguage(stored)) return stored;
  } catch { /* storage unavailable — fall through */ }
  return 'en';
};

let current: UiLanguage = readInitial();

type Listener = (lang: UiLanguage) => void;
const listeners = new Set<Listener>();

export const getLanguage = (): UiLanguage => current;

export const setLanguage = (lang: UiLanguage): void => {
  if (lang === current) return;
  current = lang;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, lang); }
  catch { /* persistence is best-effort */ }
  for (const fn of listeners) fn(lang);
};

/** Subscribe to language switches (→ force a re-render). Returns unsubscribe. */
export const onLanguageChange = (fn: Listener): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** TEST ONLY — reset to the persisted/default state between cases. */
export const __resetLanguageForTest = (): void => {
  current = readInitial();
  listeners.clear();
};

/* ------------------------------------------------------------------ */
/* String tables                                                       */
/* ------------------------------------------------------------------ */

const EN = {
  // Boot / connection
  'boot.connecting': 'Connecting to game server…',
  'boot.title': 'Summoning the Tale',
  'boot.sub': 'The Dungeon Master gathers parchment and dice',

  // Engine-loader status banner
  'status.endSuccess': 'Encounter complete — heroes prevail.',
  'status.endFailure': 'Encounter ended — heroes fall.',
  'status.endAborted': 'Encounter aborted.',
  'status.sessionGone': 'Session ended — reload the page to play again.',
  'status.queued': 'Waiting for a free game slot…',
  'status.dmComposing': 'DM is composing the scene…',
  'status.monsterPlanning': '{who} is planning its move…',
  'status.heroChoosing': '{who} is choosing an action…',
  'status.dmPreparing': 'DM is preparing…',
  'status.monsterActing': '{who} is taking action…',
  'status.yourTurn': "{who}'s turn — awaiting your move",
  'status.resolving': "Resolving {who}'s action…",
  'status.engineResolving': 'Engine resolving turn…',
  'status.connecting': 'Connecting to engine…',
  'status.aria': 'Engine activity',

  // Queue / session-gone windows
  'queue.aria': 'Waiting for a free game slot',
  'queue.title': 'The Tavern Is Full',
  'queue.lineBefore.one': 'All {capacity} adventure is underway — you are ',
  'queue.lineBefore.many': 'All {capacity} adventures are underway — you are ',
  'queue.lineAfter': ' in line.',
  'queue.sub': 'Yours begins the moment a seat frees up',
  'gone.aria': 'This game session has ended',
  'gone.title': 'The Tale Has Moved On',
  'gone.line': 'This game is no longer running on the server.',
  'gone.sub': 'Reload the page to start a fresh adventure.',
  'gone.reload': 'Reload',

  // Hero select
  'heroSelect.title': 'Choose Your Hero',
  'heroSelect.aria': 'Choose your hero',
  'heroSelect.playAs': 'Play As {name}',
  'heroSelect.cardAria': '{name}, the {archetype}',
  'heroSelect.statsAria': 'Health {health}, {kind} attack {atk}, armor {armor}',
  'heroSelect.healthTitle': 'Health: {n}',
  'heroSelect.attackTitle': '{kind} attack: {n}',
  'heroSelect.armorTitle': 'Armor: {n}',
  'lang.aria': 'Game language',

  // Attack-kind / stat words (hero cards)
  'stat.melee': 'melee',
  'stat.ranged': 'ranged',
  'stat.magic': 'magic',
  'stat.armor': 'armor',

  // Opening splash
  'opening.aria': 'Adventure opening',
  'opening.pending': 'The Dungeon Master takes up the tale',
  'opening.beginAria': 'Begin the adventure',
  'opening.skipAria': 'Skip — finish the opening text',
  'opening.continue': 'Continue',

  // Combat begins / ending / game over
  'combat.toArms': 'To Arms!',
  'combat.rollInitiative': 'Roll for Initiative',
  'end.success': 'Victory!',
  'end.failure': 'The Heroes Fall',
  'end.aborted': 'The Tale Ends',
  'end.theEnd': 'The End',
  'gameOver.title': 'Game Over',
  'gameOver.sub': 'The party has fallen',
  'gameOver.fallenAria': 'Heroes who fell',
  'gameOver.hint': 'Reload the page to begin a new tale',

  // Action buttons + selection hints
  'act.toolbarAria': 'Player actions',
  'act.attack': '⚔ Attack',
  'act.special': '✨ Special',
  'act.move': '👣 Move',
  'act.endTurn': '⏭ End Turn',
  'hint.attack': 'Click a target on the map to attack — characters, barrels, or anything the DM has dropped. Press Attack again to cancel.',
  'hint.specialNamed': '✨ {name}{desc} Click a target on the map to use it, or press Special again to cancel.',
  'hint.special': 'Click a target on the map for your special action — or press Special again to cancel.',
  'hint.move': 'Click a destination cell — or press Move again to cancel.',

  // Split-special allocation line
  'split.die.one': 'attack die',
  'split.die.many': 'attack dice',
  'split.arrow.one': 'arrow',
  'split.arrow.many': 'arrows',
  'split.assigned': ' Assigned: {list}.',
  'split.assign': 'Click a foe to assign — {left} {noun} left.',
  'split.firing': 'Firing…',
  'split.line': '✨ Split your {pool} {noun} across one or more targets.{assigned} {prompt} Right-click a target to remove a die · press Special to cancel.',

  // Prompt bar
  'prompt.panelAria': 'Prompt your action',
  'prompt.sayToAria': 'Say to',
  'prompt.party': 'Party',
  'prompt.dm': 'Dungeon Master',
  'prompt.placeholderDm': 'Ask the DM — a question, an ability test, anything. Press Enter to submit.',
  'prompt.placeholderGame': 'Prompt your action in free text — press Enter to submit.',
  'prompt.sendDmAria': 'Send your message to the DM',
  'prompt.sendGameAria': 'Send your action into the game',
  'prompt.sendTitle': 'Send (or press Enter)',
  'prompt.skip': '⏭ Skip',
  'prompt.skipAria': 'Skip turn — pass narrative control back to the DM',

  // Dialog playback controls
  'dialog.skipAria': 'Skip — finish this line or advance to the next dialogue (hotkey: A)',
  'dialog.autoOnAria': 'Auto-skip is on — click to disable and require a Skip click for each dialogue (hotkey: S)',
  'dialog.autoOffAria': 'Enable auto-skip — dialogues will advance on their own (hotkey: S)',

  // Layout chrome
  'layout.gameAria': 'Hero Kids game',
  'layout.boardAria': 'Game board',
  'log.open': 'Open event log',
  'log.close': 'Close event log',
  'log.label': 'Log',
  'survey.openAria': 'Open playtest survey',
  'survey.label': 'Survey',

  // Narrator window / player echo
  'echo.askedDmAria': 'Player asked the Dungeon Master',
  'echo.playerAsked': 'Player asked',

  // DM aside
  'aside.title': 'DM’s Aside',
  'aside.aria': 'Out-of-character note from the Dungeon Master',
  'aside.dismiss': 'Dismiss',
  'aside.dismissAria': 'Dismiss this aside',
  'aside.youAsked': 'You asked',
  'aside.dm': 'Dungeon Master',
  'aside.consulting': 'consults the tomes',

  // Turn order / dice HUD
  'turnOrder.dead': 'DEAD',
  'dice.skillCheck': 'skill check',
  'dice.foe': 'foe',

  // Survey modal
  'survey.title': 'Playtest Survey',
  'survey.aria': 'Playtest survey',
  'survey.closeAria': 'Close survey',
  'survey.intro': 'Thanks for playing! Score each statement about your AI teammates, right after your run while it’s fresh.',
  'survey.legend': '1 = Strongly disagree · 3 = Neutral · 5 = Strongly agree',
  'survey.optional': 'Optional',
  'survey.oneMoment': 'One moment',
  'survey.momentText': 'Describe the single best or worst coordination moment you remember.',
  'survey.momentPlaceholder': 'It was great/terrible when…',
  'survey.copy': 'Copy',
  'survey.copyTitle': 'Copy the answers as markdown (fallback if saving fails)',
  'survey.submit': 'Submit',
  'survey.saving': 'Saving…',
  'survey.savedBtn': 'Saved ✓',
  'survey.savedThanks': 'Saved — thank you!',
  'survey.savedLocal': 'Saved on the game server — thank you!',
  'survey.failed': 'Couldn’t save — use Copy instead.',
  'survey.copied': 'Copied — paste it to the researcher!',
  'survey.clipboardBlocked': 'Clipboard blocked — downloaded instead.',
  'survey.scoreAria': '{title} score',
  'survey.run': 'Run {id}',
  'survey.mdHeader': '# Playtest Survey — Hero Kids with AI Teammates',
  'survey.mdOptional': '(optional)',
  'survey.mdFooter': '*Run ID: {id} · Date: {date}*',
  'survey.q.coordination.title': 'AI–AI coordination',
  'survey.q.coordination.text': 'The two AI heroes worked together as a team — they set up and built on each other’s moves instead of acting solo.',
  'survey.q.responsiveness.title': 'Responsiveness to me',
  'survey.q.responsiveness.text': 'The AI heroes noticed what I did and said, and adjusted their actions to it within a turn or two.',
  'survey.q.communication.title': 'Communication usefulness',
  'survey.q.communication.text': 'What the heroes said was actually helpful for coordinating (calling plays, answering mine) — not just flavor chatter.',
  'survey.q.persona.title': 'Persona distinctiveness',
  'survey.q.persona.text': 'Each hero felt like a distinct, consistent character — I could tell them apart by how they spoke and fought.',
  'survey.q.trust.title': 'Teaming & trust (overall)',
  'survey.q.trust.text': 'Overall, the AI heroes felt like real teammates I could rely on; I’d happily play with them again.',
  'survey.q.effort.title': 'Mental effort',
  'survey.q.effort.text': 'How mentally demanding was it to coordinate with the AI heroes? (1 = effortless · 5 = very demanding)',
} as const;

export type MessageKey = keyof typeof EN;

const PT: Record<MessageKey, string> = {
  // Boot / connection
  'boot.connecting': 'Conectando ao servidor do jogo…',
  'boot.title': 'Invocando a História',
  'boot.sub': 'O Mestre reúne pergaminho e dados',

  // Engine-loader status banner
  'status.endSuccess': 'Encontro concluído — os heróis triunfam.',
  'status.endFailure': 'Encontro encerrado — os heróis caem.',
  'status.endAborted': 'Encontro abortado.',
  'status.sessionGone': 'Sessão encerrada — recarregue a página para jogar de novo.',
  'status.queued': 'Aguardando uma vaga de jogo…',
  'status.dmComposing': 'O Mestre está compondo a cena…',
  'status.monsterPlanning': '{who} está planejando seu movimento…',
  'status.heroChoosing': '{who} está escolhendo uma ação…',
  'status.dmPreparing': 'O Mestre está se preparando…',
  'status.monsterActing': '{who} está agindo…',
  'status.yourTurn': 'Vez de {who} — aguardando sua jogada',
  'status.resolving': 'Resolvendo a ação de {who}…',
  'status.engineResolving': 'O motor está resolvendo o turno…',
  'status.connecting': 'Conectando ao motor…',
  'status.aria': 'Atividade do motor',

  // Queue / session-gone windows
  'queue.aria': 'Aguardando uma vaga de jogo',
  'queue.title': 'A Taverna Está Cheia',
  'queue.lineBefore.one': 'A aventura está em andamento — você é ',
  'queue.lineBefore.many': 'Todas as {capacity} aventuras estão em andamento — você é ',
  'queue.lineAfter': ' na fila.',
  'queue.sub': 'A sua começa assim que uma vaga abrir',
  'gone.aria': 'Esta sessão de jogo terminou',
  'gone.title': 'A História Seguiu em Frente',
  'gone.line': 'Este jogo não está mais rodando no servidor.',
  'gone.sub': 'Recarregue a página para começar uma nova aventura.',
  'gone.reload': 'Recarregar',

  // Hero select
  'heroSelect.title': 'Escolha Seu Herói',
  'heroSelect.aria': 'Escolha seu herói',
  'heroSelect.playAs': 'Jogar Como {name}',
  'heroSelect.cardAria': '{name}, {archetype}',
  'heroSelect.statsAria': 'Vida {health}, ataque {kind} {atk}, armadura {armor}',
  'heroSelect.healthTitle': 'Vida: {n}',
  'heroSelect.attackTitle': 'Ataque {kind}: {n}',
  'heroSelect.armorTitle': 'Armadura: {n}',
  'lang.aria': 'Idioma do jogo',

  // Attack-kind / stat words (hero cards)
  'stat.melee': 'corpo a corpo',
  'stat.ranged': 'à distância',
  'stat.magic': 'mágico',
  'stat.armor': 'armadura',

  // Opening splash
  'opening.aria': 'Abertura da aventura',
  'opening.pending': 'O Mestre retoma a história',
  'opening.beginAria': 'Começar a aventura',
  'opening.skipAria': 'Pular — concluir o texto de abertura',
  'opening.continue': 'Continuar',

  // Combat begins / ending / game over
  'combat.toArms': 'Combate!',
  'combat.rollInitiative': 'Rolem a Iniciativa',
  'end.success': 'Vitória!',
  'end.failure': 'Os Heróis Caem',
  'end.aborted': 'A História Termina',
  'end.theEnd': 'Fim',
  'gameOver.title': 'Fim de Jogo',
  'gameOver.sub': 'O grupo caiu',
  'gameOver.fallenAria': 'Heróis que caíram',
  'gameOver.hint': 'Recarregue a página para começar uma nova história',

  // Action buttons + selection hints
  'act.toolbarAria': 'Ações do jogador',
  'act.attack': '⚔ Atacar',
  'act.special': '✨ Especial',
  'act.move': '👣 Mover',
  'act.endTurn': '⏭ Encerrar Turno',
  'hint.attack': 'Clique em um alvo no mapa para atacar — personagens, barris ou qualquer coisa que o Mestre tenha colocado. Aperte Atacar de novo para cancelar.',
  'hint.specialNamed': '✨ {name}{desc} Clique em um alvo no mapa para usar, ou aperte Especial de novo para cancelar.',
  'hint.special': 'Clique em um alvo no mapa para sua ação especial — ou aperte Especial de novo para cancelar.',
  'hint.move': 'Clique em uma célula de destino — ou aperte Mover de novo para cancelar.',

  // Split-special allocation line
  'split.die.one': 'dado de ataque',
  'split.die.many': 'dados de ataque',
  'split.arrow.one': 'flecha',
  'split.arrow.many': 'flechas',
  'split.assigned': ' Atribuídos: {list}.',
  'split.assign': 'Clique em um inimigo para atribuir — {left} {noun} restantes.',
  'split.firing': 'Disparando…',
  'split.line': '✨ Divida seus {pool} {noun} entre um ou mais alvos.{assigned} {prompt} Clique com o botão direito em um alvo para remover um dado · aperte Especial para cancelar.',

  // Prompt bar
  'prompt.panelAria': 'Descreva sua ação',
  'prompt.sayToAria': 'Falar com',
  'prompt.party': 'Grupo',
  'prompt.dm': 'Mestre',
  'prompt.placeholderDm': 'Pergunte ao Mestre — uma dúvida, um teste de habilidade, qualquer coisa. Aperte Enter para enviar.',
  'prompt.placeholderGame': 'Descreva sua ação em texto livre — aperte Enter para enviar.',
  'prompt.sendDmAria': 'Enviar sua mensagem ao Mestre',
  'prompt.sendGameAria': 'Enviar sua ação para o jogo',
  'prompt.sendTitle': 'Enviar (ou aperte Enter)',
  'prompt.skip': '⏭ Pular',
  'prompt.skipAria': 'Pular o turno — devolver o controle da narrativa ao Mestre',

  // Dialog playback controls
  'dialog.skipAria': 'Pular — concluir esta fala ou avançar para a próxima (tecla A)',
  'dialog.autoOnAria': 'Avanço automático ligado — clique para desativar e exigir um clique em Pular a cada fala (tecla S)',
  'dialog.autoOffAria': 'Ativar avanço automático — as falas avançam sozinhas (tecla S)',

  // Layout chrome
  'layout.gameAria': 'Jogo Hero Kids',
  'layout.boardAria': 'Tabuleiro do jogo',
  'log.open': 'Abrir registro de eventos',
  'log.close': 'Fechar registro de eventos',
  'log.label': 'Registro',
  'survey.openAria': 'Abrir pesquisa de playtest',
  'survey.label': 'Pesquisa',

  // Narrator window / player echo
  'echo.askedDmAria': 'O jogador perguntou ao Mestre',
  'echo.playerAsked': 'O jogador perguntou',

  // DM aside
  'aside.title': 'Nota do Mestre',
  'aside.aria': 'Nota fora do personagem do Mestre',
  'aside.dismiss': 'Dispensar',
  'aside.dismissAria': 'Dispensar esta nota',
  'aside.youAsked': 'Você perguntou',
  'aside.dm': 'Mestre',
  'aside.consulting': 'consulta os tomos',

  // Turn order / dice HUD
  'turnOrder.dead': 'MORTO',
  'dice.skillCheck': 'teste de perícia',
  'dice.foe': 'inimigo',

  // Survey modal — the research instrument; wording reviewed for pt-BR.
  'survey.title': 'Pesquisa de Playtest',
  'survey.aria': 'Pesquisa de playtest',
  'survey.closeAria': 'Fechar pesquisa',
  'survey.intro': 'Obrigado por jogar! Avalie cada afirmação sobre seus companheiros de IA logo após a partida, enquanto está fresco na memória.',
  'survey.legend': '1 = Discordo totalmente · 3 = Neutro · 5 = Concordo totalmente',
  'survey.optional': 'Opcional',
  'survey.oneMoment': 'Um momento',
  'survey.momentText': 'Descreva o melhor ou o pior momento de coordenação de que você se lembra.',
  'survey.momentPlaceholder': 'Foi ótimo/terrível quando…',
  'survey.copy': 'Copiar',
  'survey.copyTitle': 'Copiar as respostas em markdown (alternativa se salvar falhar)',
  'survey.submit': 'Enviar',
  'survey.saving': 'Salvando…',
  'survey.savedBtn': 'Salvo ✓',
  'survey.savedThanks': 'Salvo — obrigado!',
  'survey.savedLocal': 'Salvo no servidor do jogo — obrigado!',
  'survey.failed': 'Não foi possível salvar — use Copiar.',
  'survey.copied': 'Copiado — cole para o pesquisador!',
  'survey.clipboardBlocked': 'Área de transferência bloqueada — baixado como arquivo.',
  'survey.scoreAria': 'nota de {title}',
  'survey.run': 'Partida {id}',
  'survey.mdHeader': '# Pesquisa de Playtest — Hero Kids com Companheiros de IA',
  'survey.mdOptional': '(opcional)',
  'survey.mdFooter': '*ID da partida: {id} · Data: {date}*',
  'survey.q.coordination.title': 'Coordenação IA–IA',
  'survey.q.coordination.text': 'Os dois heróis de IA trabalharam em equipe — prepararam e aproveitaram as jogadas um do outro em vez de agir sozinhos.',
  'survey.q.responsiveness.title': 'Resposta a mim',
  'survey.q.responsiveness.text': 'Os heróis de IA perceberam o que eu fiz e disse, e ajustaram suas ações a isso em um ou dois turnos.',
  'survey.q.communication.title': 'Utilidade da comunicação',
  'survey.q.communication.text': 'O que os heróis disseram foi realmente útil para coordenar (chamando jogadas, respondendo às minhas) — não só conversa de ambientação.',
  'survey.q.persona.title': 'Distinção das personas',
  'survey.q.persona.text': 'Cada herói pareceu um personagem distinto e consistente — eu conseguia diferenciá-los pelo jeito de falar e lutar.',
  'survey.q.trust.title': 'Equipe e confiança (geral)',
  'survey.q.trust.text': 'No geral, os heróis de IA pareceram companheiros de equipe de verdade, em quem eu podia confiar; eu jogaria com eles de novo com prazer.',
  'survey.q.effort.title': 'Esforço mental',
  'survey.q.effort.text': 'Quão exigente mentalmente foi coordenar com os heróis de IA? (1 = sem esforço · 5 = muito exigente)',
};

const TABLES: Record<UiLanguage, Record<MessageKey, string>> = { en: EN, pt: PT };

/** Interpolate `{var}` placeholders. Missing vars render as the placeholder
 *  itself, so a forgotten argument is visible instead of silently blank. */
const interpolate = (template: string, vars?: Record<string, string | number>): string =>
  vars
    ? template.replace(/\{(\w+)\}/g, (m, name: string) =>
        name in vars ? String(vars[name]) : m)
    : template;

/** Look up `key` in the current language (English fallback) and interpolate. */
export const t = (key: MessageKey, vars?: Record<string, string | number>): string =>
  interpolate(TABLES[current][key] ?? EN[key] ?? String(key), vars);

/** Whether a (possibly dynamic) key exists in the catalogue — used by callers
 *  that derive keys from data ids and need a graceful fallback. */
export const hasMessage = (key: string): key is MessageKey => key in EN;

/** Display translation for the small fixed archetype set (hero cards, dice-HUD
 *  subtitles), keyed per language. Unknown archetypes — and languages without
 *  a table — pass through untranslated. */
const ARCHETYPES: Partial<Record<UiLanguage, Record<string, string>>> = {
  pt: {
    warrior: 'guerreiro',
    hunter: 'caçador',
    healer: 'curandeira',
    warlock: 'bruxo',
  },
};

export const translateArchetype = (archetype: string): string =>
  ARCHETYPES[current]?.[archetype.toLowerCase()] ?? archetype;

/**
 * Display translation for catalog CREATURE names (data/monsters.json), keyed
 * per language — the engine keeps the canonical English (it's also LLM
 * context and the stable research record); the browser translates at DISPLAY
 * time only (turn order, dice-HUD nameplates, status banner, speech-bubble
 * attribution), all of which route through `displayName`
 * (web/components/names.ts). Exact-match on the title-cased name; hero/NPC
 * proper nouns (Gareth, Mira…) pass through.
 */
const GAME_TERMS: Partial<Record<UiLanguage, Record<string, string>>> = {
  pt: {
    'Giant Rat': 'Rato Gigante',
    'King Rat': 'Rato Rei',
    // Both the raw catalog name and displayName's title-cased form
    // ("Thorn-wisp" splits on '-' → "Thorn Wisp") — callers hit this map
    // from either side.
    'Thorn-wisp': 'Fiapo de Espinhos',
    'Thorn Wisp': 'Fiapo de Espinhos',
    'Nimue, the Grieving Dryad': 'Nimue, a Dríade Enlutada',
    'Goblin Warboss': 'Chefe de Guerra Goblin',
  },
};

export const translateGameTerm = (name: string): string =>
  GAME_TERMS[current]?.[name] ?? name;
