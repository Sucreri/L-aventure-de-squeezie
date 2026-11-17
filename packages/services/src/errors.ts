/**
 * Translating database refusals into something a client can act on.
 *
 * The guards in Postgres carry a message and usually a HINT naming the rule
 * and the specification section. Rather than inventing a second vocabulary,
 * this module classifies the refusal and keeps the original text, so a
 * developer reading a log still sees exactly which guard fired.
 */

/** A rule refused the operation. Not a bug: the system working as intended. */
export class RuleRefusedError extends Error {
  readonly kind: RefusalKind;
  readonly userMessage: string;
  readonly databaseMessage: string;
  readonly hint: string | undefined;

  constructor(kind: RefusalKind, userMessage: string, databaseMessage: string, hint?: string) {
    super(userMessage);
    this.name = 'RuleRefusedError';
    this.kind = kind;
    this.userMessage = userMessage;
    this.databaseMessage = databaseMessage;
    this.hint = hint;
  }
}

export type RefusalKind =
  | 'age'
  | 'zone_not_open'
  | 'address_outside_area'
  | 'account_not_verified'
  | 'courier_not_employable'
  | 'night_work'
  | 'launch_parameters_missing'
  | 'forbidden_promotion'
  | 'forbidden_transition'
  | 'delivery_checks_missing'
  | 'independent_mode_locked'
  | 'spend_ceiling'
  | 'geolocation'
  | 'unknown';

interface PostgresError {
  message?: string;
  hint?: string;
  code?: string;
}

/**
 * Maps a refusal to a kind and a message in French for the client.
 *
 * The ordering matters: the more specific patterns come first, because several
 * guards mention overlapping vocabulary.
 */
const PATTERNS: readonly { test: RegExp; kind: RefusalKind; message: string }[] = [
  { test: /age requirement not met|age check is required|age check did not pass/i,
    kind: 'age',
    message: "L'âge requis n'est pas satisfait pour l'un des articles." },
  { test: /verified account|ordering requires a verified account|must hold a verified account/i,
    kind: 'account_not_verified',
    message: 'Un compte vérifié, avec les CGU et les CGV acceptées, est nécessaire.' },
  { test: /outside the service area/i,
    kind: 'address_outside_area',
    message: "Cette adresse est en dehors de la zone de service." },
  { test: /not open yet|still on the waiting list/i,
    kind: 'zone_not_open',
    message: "Ce quartier n'est pas encore ouvert. Vous pouvez rejoindre la liste d'attente." },
  { test: /launch parameters are missing/i,
    kind: 'launch_parameters_missing',
    message: "Des paramètres obligatoires ne sont pas renseignés : l'ouverture est bloquée." },
  { test: /signed contract and a confirmed dimona|contract or dimona missing|chk_active_requires_contract_and_dimona/i,
    kind: 'courier_not_employable',
    message: "Ce palettier n'a pas de contrat signé ou de Dimona confirmée." },
  { test: /night derogation|service end time/i,
    kind: 'night_work',
    message: 'Ce créneau dépasse les horaires autorisés sans dérogation validée.' },
  { test: /forbidden promotion condition|may not reference a product or alcohol/i,
    kind: 'forbidden_promotion',
    message: 'Cette promotion est interdite : une réduction ne peut porter que sur les frais.' },
  { test: /forbidden order transition/i,
    kind: 'forbidden_transition',
    message: "Cette opération n'est pas possible à ce stade de la commande." },
  { test: /requires a verified pin|invalid pin|DELIVERED requires/i,
    kind: 'delivery_checks_missing',
    message: 'La livraison ne peut pas être validée sans contrôle d\'âge puis code PIN correct.' },
  { test: /independent mode is locked/i,
    kind: 'independent_mode_locked',
    message: 'Le mode indépendant est verrouillé et ne peut pas être activé.' },
  { test: /spend card ceiling exceeded/i,
    kind: 'spend_ceiling',
    message: 'Le plafond de la carte de dépense est dépassé pour cette mission.' },
  { test: /has not consented|outside the booked shift/i,
    kind: 'geolocation',
    message: 'La position ne peut être enregistrée que pendant un créneau réservé et avec consentement.' },
];

export function translateDatabaseError(error: unknown): RuleRefusedError | null {
  const pg = error as PostgresError;
  const message = typeof pg?.message === 'string' ? pg.message : '';
  if (!message) return null;

  for (const pattern of PATTERNS) {
    if (pattern.test.test(message) || (pg.hint && pattern.test.test(pg.hint))) {
      return new RuleRefusedError(pattern.kind, pattern.message, message, pg.hint);
    }
  }

  // A check constraint we have not named explicitly is still a refusal, not a
  // crash. Surfacing it as 'unknown' keeps the original text visible.
  if (pg.code === '23514' || pg.code === '23505') {
    return new RuleRefusedError('unknown',
      "Cette opération a été refusée par une règle du service.", message, pg.hint);
  }

  return null;
}

/** Wraps a call so that any rule refusal surfaces as a RuleRefusedError. */
export async function refusalAware<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const translated = translateDatabaseError(error);
    throw translated ?? error;
  }
}
