import type { NormalizedMessage } from '../ingestion/mail-adapter';
import {
  CLINICIAN_ADDRESSES,
  CLINICIAN_NAME_PATTERN,
  KNOWN_CONTACT_NAMES,
  ROLE_LABELS,
  roleForAddress,
  type ContactRole,
} from './contacts';

// Local redaction before any cloud analysis (PRD F08, ARCHITECTURE section 7).
// Identifying text is replaced with aliases or role placeholders; the alias
// table stays on this computer. If anything that looks identifying survives,
// redaction fails closed and nothing is uploaded.

export interface RedactedMessage {
  /** Position in the thread, oldest first. */
  index: number;
  sender: string;
  receivedAt: string | null;
  subject: string;
  body: string;
}

export type RedactionResult =
  | { ok: true; messages: RedactedMessage[]; senderRole: string | null }
  | { ok: false; reason: string };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;
const PHONE = /(?<![\d:])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\d:])/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const LONG_NUMBER = /\b\d{7,}\b/g;
const CREDENTIAL_LABELLED = /\b(password|passcode|passwd|pin|api[ _-]?key|token)\s*[:=]\s*\S+/gi;
const CREDENTIAL_TOKEN = /\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{10,}\b|\b[A-Za-z0-9_-]{40,}\b/g;
const STREET =
  /\b\d{1,5}\s+(?:[A-Z][A-Za-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Terrace|Pike)\b\.?/g;
const VIDEO_LINK_HOSTS = /zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com/i;

/** Health details unrelated to scheduling; replaced so they are never uploaded. */
const HEALTH_TERMS = new RegExp(
  '\\b(?:' +
    [
      'physical therap(?:y|ist)',
      'physiotherap(?:y|ist)',
      'chemo(?:therapy)?',
      'radiation',
      'surgery',
      'surgeon',
      'dentist',
      'doctor(?:\'s)?',
      'physician',
      'hospital(?:ized)?',
      'emergency room',
      'urgent care',
      'diagnos(?:is|ed|e)',
      'medications?',
      'prescriptions?',
      'psychiatrist',
      'depress(?:ion|ed)',
      'anxiety',
      'panic attacks?',
      'suicidal',
      'self[- ]harm',
      'overdose',
      'rehab(?:ilitation)?',
      'pregnan(?:t|cy)',
      'MRI',
      'x-?rays?',
      'biopsy',
      'cancer',
      'diabetes',
      'covid(?:-19)?',
      'flu',
    ].join('|') +
    ')\\b',
  'gi',
);

/** Capitalized words that are not personal names in greetings or sign-offs. */
const NOT_NAMES = new Set(
  [
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december', 'there', 'all', 'team', 'everyone',
    'thanks', 'thank', 'regards', 'best', 'sincerely', 'cheers', 'again', 'you', 'zoom',
    'the', 'and', 'from', 'this', 'that', 'sir', 'madam', 'friend', 'folks',
  ].map((w) => w.toLowerCase()),
);

const NAME = "[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?";
const GREETING = new RegExp(
  `^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))[ ,]+(${NAME}(?:\\s+${NAME})?)\\b`,
  'gim',
);
const INTRO = new RegExp(`\\b(?:this is|my name is|i am|i'm)\\s+(${NAME}(?:\\s+${NAME})?)\\b`, 'g');
const SIGN_OFF = new RegExp(
  `(?:^|[.!?]\\s+|\\n)\\s*(?:[-–—~]\\s*|(?:thanks|thank you|best|regards|sincerely|cheers|warmly|take care)[,!.]?\\s+)(${NAME}(?:\\s+${NAME})?)\\.?\\s*$`,
  'i',
);

/** Strips signatures, device footers, and license/credential lines. */
function stripBoilerplate(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^--\s*$/.test(line)) break; // conventional signature delimiter
    if (/^sent from my /i.test(line.trim())) continue;
    if (/\b(?:LCSW|LPC|LMFT|LSW|PhD|PsyD|license|lic\.)\b.*\d{4,}/i.test(line)) continue;
    if (/^\s*job title\s*\|/i.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

/** Removes quoted earlier replies, used when the thread is supplied separately. */
export function stripQuotedReply(text: string): string {
  const lines = text.split('\n');
  const cut = lines.findIndex((line) => /^On .{4,200} wrote:\s*$/.test(line.trim()) || /^>/.test(line));
  return (cut === -1 ? lines : lines.slice(0, cut)).join('\n').trim();
}

/**
 * Redacts one thread with a shared alias table, so the same person keeps the
 * same alias across messages. Create one Redactor per analysis.
 */
export class Redactor {
  private readonly aliases = new Map<string, string>(); // original (lowercase) -> alias
  private readonly originals = new Map<string, string>(); // alias -> original
  private personCount = 0;
  private emailCount = 0;

  /** @param ownerAddresses connected account addresses; mail from them is the clinician's. */
  constructor(private readonly ownerAddresses: string[] = []) {}

  /** Local-only alias table for restoring identities later. Never upload this. */
  aliasTable(): ReadonlyMap<string, string> {
    return this.originals;
  }

  redactThread(messages: NormalizedMessage[], options: { stripQuotes: boolean }): RedactionResult {
    try {
      const target = messages[messages.length - 1];
      const senderRole = this.senderRole(target?.from ?? null);
      const redacted = messages.map((message, index) => {
        // Learn names from headers and salutations before replacing anything.
        this.learnSenderName(message.from);
        const rawBody = options.stripQuotes ? stripQuotedReply(message.bodyText) : message.bodyText;
        const body = stripBoilerplate(rawBody);
        this.learnNamesFromText(body);
        return {
          index,
          sender: this.describeSender(message.from),
          receivedAt: message.receivedAt,
          subject: this.redactText(message.subject ?? ''),
          body: this.redactText(body),
        };
      });
      for (const message of redacted) {
        const leak = residualLeak(message.subject + '\n' + message.body);
        if (leak) return { ok: false, reason: `residual ${leak}` };
      }
      return { ok: true, messages: redacted, senderRole };
    } catch {
      return { ok: false, reason: 'redaction error' };
    }
  }

  private isOwner(address: string): boolean {
    const lower = address.toLowerCase();
    return CLINICIAN_ADDRESSES.has(lower) || this.ownerAddresses.some((a) => a.toLowerCase() === lower);
  }

  private senderRole(from: string | null): string | null {
    const address = extractAddress(from);
    if (!address) return null;
    if (this.isOwner(address)) return 'the clinician (account owner)';
    const role = roleForAddress(address);
    return role ? ROLE_LABELS[role] : null;
  }

  private describeSender(from: string | null): string {
    const address = extractAddress(from);
    if (!address) return 'unknown sender';
    if (this.isOwner(address)) return '[CLINICIAN]';
    const role = roleForAddress(address);
    if (role) return roleToken(role);
    return this.aliasFor(displayName(from) ?? address, 'PERSON');
  }

  private learnSenderName(from: string | null): void {
    const address = extractAddress(from);
    if (!address || this.isOwner(address)) return;
    const name = displayName(from);
    if (name && !roleForAddress(address)) {
      this.aliasFor(name, 'PERSON');
      // Also catch the first name alone, e.g. "Thanks, Dana".
      const first = name.split(/\s+/)[0];
      if (first && first.length > 1 && !NOT_NAMES.has(first.toLowerCase())) this.linkName(first, name);
    }
  }

  private learnNamesFromText(text: string): void {
    const candidates: string[] = [];
    for (const match of text.matchAll(GREETING)) candidates.push(match[1]);
    for (const match of text.matchAll(INTRO)) candidates.push(match[1]);
    const signOff = text.trim().match(SIGN_OFF);
    if (signOff) candidates.push(signOff[1]);
    for (const candidate of candidates) {
      const words = candidate.split(/\s+/).filter((w) => !NOT_NAMES.has(w.toLowerCase()));
      if (words.length === 0) continue;
      const name = words.join(' ');
      if (new RegExp(CLINICIAN_NAME_PATTERN.source, 'i').test(name)) continue;
      if (KNOWN_CONTACT_NAMES.some(({ pattern }) => new RegExp(pattern.source, 'i').test(name))) continue;
      this.aliasFor(name, 'PERSON');
    }
  }

  private aliasFor(original: string, kind: 'PERSON' | 'EMAIL'): string {
    const key = original.trim().toLowerCase();
    const existing = this.aliases.get(key);
    if (existing) return existing;
    const alias = kind === 'PERSON' ? `[PERSON_${++this.personCount}]` : `[EMAIL_${++this.emailCount}]`;
    this.aliases.set(key, alias);
    this.originals.set(alias, original.trim());
    return alias;
  }

  /** Maps another spelling (e.g. a first name) to an existing alias. */
  private linkName(variant: string, original: string): void {
    const alias = this.aliases.get(original.trim().toLowerCase());
    if (alias && !this.aliases.has(variant.toLowerCase())) this.aliases.set(variant.toLowerCase(), alias);
  }

  private redactText(input: string): string {
    let text = input;
    text = text.replace(CREDENTIAL_LABELLED, (_, label: string) => `${label}: [REDACTED]`);
    text = text.replace(URL_PATTERN, (url) => (VIDEO_LINK_HOSTS.test(url) ? '[VIDEO_MEETING_LINK]' : '[LINK]'));
    text = text.replace(EMAIL, (address) => {
      if (this.isOwner(address)) return '[CLINICIAN_EMAIL]';
      const role = roleForAddress(address);
      return role ? roleToken(role) : this.aliasFor(address, 'EMAIL');
    });
    text = text.replace(CREDENTIAL_TOKEN, '[REDACTED]');
    text = text.replace(SSN, '[ID_NUMBER]');
    text = text.replace(PHONE, '[PHONE]');
    text = text.replace(LONG_NUMBER, '[NUMBER]');
    text = text.replace(STREET, '[ADDRESS]');
    text = text.replace(HEALTH_TERMS, '[HEALTH_DETAIL]');
    for (const { pattern, role } of KNOWN_CONTACT_NAMES) {
      text = text.replace(new RegExp(pattern.source, 'gi'), roleToken(role));
    }
    text = text.replace(new RegExp(CLINICIAN_NAME_PATTERN.source, 'gi'), '[CLINICIAN]');
    // Longest names first so "Dana Lee" is replaced before "Dana".
    const names = [...this.aliases.entries()]
      .filter(([original]) => !original.includes('@'))
      .sort((a, b) => b[0].length - a[0].length);
    for (const [original, alias] of names) {
      text = text.replace(new RegExp(`\\b${escapeRegExp(original)}\\b`, 'gi'), alias);
    }
    return text;
  }
}

function roleToken(role: ContactRole): string {
  return `[${role.toUpperCase().replace(/-/g, '_')}]`;
}

export function extractAddress(from: string | null): string | null {
  if (!from) return null;
  const angle = from.match(/<([^>]+)>/);
  const address = (angle ? angle[1] : from).trim();
  return /@/.test(address) ? address.toLowerCase() : null;
}

function displayName(from: string | null): string | null {
  if (!from) return null;
  const match = from.match(/^\s*"?([^"<]+?)"?\s*</);
  const name = match?.[1]?.trim();
  return name && !name.includes('@') ? name : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns what kind of identifying text survived, if any. */
export function residualLeak(text: string): string | null {
  if (new RegExp(EMAIL.source).test(text)) return 'email address';
  if (new RegExp(URL_PATTERN.source, 'i').test(text)) return 'link';
  if (new RegExp(PHONE.source).test(text)) return 'phone number';
  if (new RegExp(SSN.source).test(text)) return 'identification number';
  return null;
}
